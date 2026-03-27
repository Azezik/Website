/**
 * WFG3 Browser Engine — stand-alone, no WFG2 dependency.
 *
 * Runs the real WFG3 pipeline (Stages A–F implemented, G–H stubbed)
 * using wfg3-cv.js, wfg3-stages-ac.js, and wfg3-stages-df.js.
 *
 * Exposes window.WrokitFeatureGraph3 with the same public API shape
 * that the Wrokit app expects from a graph learning engine.
 *
 * Depends on: wfg3-cv.js, wfg3-stages-ac.js, wfg3-stages-df.js (must be loaded first)
 */
(function (global) {
  'use strict';

  var CV = global._WFG3_CV;
  var Stages = global._WFG3_Stages;
  if (!CV) throw new Error('wfg3-browser-engine.js requires wfg3-cv.js');
  if (!Stages) throw new Error('wfg3-browser-engine.js requires wfg3-stages-ac.js');
  if (!Stages.stageD) throw new Error('wfg3-browser-engine.js requires wfg3-stages-df.js');

  /* ── Default params (WFG3-native, not borrowed from WFG2) ── */

  var DEFAULT_PARAMS = Object.freeze({
    _schemaVersion: 1,
    _engine: 'wfg3',

    // Stage A
    maxDim: 1400,
    denoiseMode: 'bilateral',
    denoiseRadius: 2,
    bilateralSigmaC: 35,
    bilateralSigmaS: 35,

    // Stage B
    cannyLow: 60,
    cannyHigh: 160,
    labDeltaThreshold: 12.0,
    morphRadius: 1,
    edgeWeightCanny: 0.7,
    edgeWeightGradient: 0.3,

    // Stage C
    tokenStep: 2,
    tokenSideSamplePx: 3,
    tokenConfidenceDeltaEMax: 40.0,
    tokenMinConfidence: 0.05,

    // Stage D
    graphNeighborRadius: 4,
    graphOrientationTolDeg: 35,
    graphSideDeltaETol: 25,
    chainMinLength: 3,

    // Stage E
    watershedFgFraction: 0.25,
    minRegionArea: 24,
    boundaryBoostWeight: 0.4,

    // Stage F
    groupMergeThreshold: 0.45,
    groupMinPerimeterRatio: 0.15,

    // Pipeline mode (WFG3 currently only supports 'partition')
    pipelineMode: 'partition'
  });

  function copyParams(params) {
    if (!params) return JSON.parse(JSON.stringify(DEFAULT_PARAMS));
    return JSON.parse(JSON.stringify(params));
  }

  /* ── Stage A: normalizeVisualInput ── */

  function normalizeVisualInput(imageData, opts) {
    var cfg = Object.assign({}, Stages.DEFAULT_CONFIG_AC, { maxDim: (opts && opts.maxSide) || 1400 });
    var surface = Stages.stageA(imageData, opts, cfg);
    if (!surface) return null;
    // The surface already has the shape the app expects:
    // { kind, width, height, gray, rgb, lab, source, artifacts }
    return surface;
  }

  /* ── Stages B–F: generateFeatureGraph ── */

  function generateFeatureGraph(normalizedSurface, params) {
    if (!normalizedSurface) return null;
    var p = params || DEFAULT_PARAMS;
    var cfgAC = Object.assign({}, Stages.DEFAULT_CONFIG_AC, p);
    var cfgDF = Object.assign({}, Stages.DEFAULT_CONFIG_DF, p);

    var w = normalizedSurface.width;
    var h = normalizedSurface.height;
    var n = w * h;

    // Run Stage B: Boundary Evidence
    var evidence = Stages.stageB(normalizedSurface, cfgAC);

    // Run Stage C: Boundary Tokens
    var tokens = Stages.stageC(normalizedSurface, evidence, cfgAC);

    // Run Stage D: Boundary Graph Assembly
    var boundaryGraph = Stages.stageD(tokens, evidence, cfgDF);

    // Run Stage E: Region Partition (boundary-graph-informed watershed)
    var partition = Stages.stageE(normalizedSurface, evidence, boundaryGraph, cfgDF);

    // Run Stage F: Region Grouping (union-find merge)
    var groupMap = Stages.stageF(partition, normalizedSurface, cfgDF);

    // Cache for computeGroupedGraph re-runs with different thresholds
    _lastSurface = normalizedSurface;
    _lastPartitionStats = partition.stats;

    // Build nodes: one node per region with centroid, area, bbox
    var nodes = [];
    var regionStats = partition.stats;
    for (var rid in regionStats) {
      var rs = regionStats[rid];
      nodes.push({
        id: +rid,
        x: rs.cx,
        y: rs.cy,
        area: rs.area,
        bbox: { x: rs.bboxX, y: rs.bboxY, w: rs.bboxW, h: rs.bboxH },
        label: 'R' + rid
      });
    }

    // Build edges from region adjacency
    var edges = [];
    var edgeId = 0;
    var seenEdges = {};
    var adj = partition.adjacency;
    for (var src in adj) {
      var neighbors = adj[src];
      for (var ni = 0; ni < neighbors.length; ni++) {
        var dst = neighbors[ni];
        var ek = Math.min(+src, dst) + ',' + Math.max(+src, dst);
        if (seenEdges[ek]) continue;
        seenEdges[ek] = true;
        edges.push({ id: edgeId++, source: +src, target: dst });
      }
    }

    // Compute region mean LAB for WFG2-compat partitionRegionMeans
    var regionMeans = null;
    if (normalizedSurface.lab) {
      regionMeans = {};
      var labL = normalizedSurface.lab.L, labA = normalizedSurface.lab.a, labB = normalizedSurface.lab.b;
      var sums = {};
      for (var ri = 1; ri <= partition.regionCount; ri++) sums[ri] = { L: 0, a: 0, b: 0, n: 0 };
      for (var pi = 0; pi < n; pi++) {
        var rl = partition.labelMap[pi];
        if (rl > 0 && sums[rl]) { sums[rl].L += labL[pi]; sums[rl].a += labA[pi]; sums[rl].b += labB[pi]; sums[rl].n++; }
      }
      for (var ri2 in sums) {
        var s = sums[ri2];
        if (s.n > 0) regionMeans[ri2] = { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
      }
    }

    // Compute shared boundary lengths for WFG2-compat
    var sharedBoundaries = {};
    var dx4 = [1, 0], dy4 = [0, 1];
    for (var sy = 0; sy < h; sy++) {
      for (var sx = 0; sx < w; sx++) {
        var sl = partition.labelMap[sy * w + sx];
        if (sl <= 0) continue;
        for (var sd = 0; sd < 2; sd++) {
          var snx = sx + dx4[sd], sny = sy + dy4[sd];
          if (snx >= w || sny >= h) continue;
          var snl = partition.labelMap[sny * w + snx];
          if (snl > 0 && snl !== sl) {
            var sbk = Math.min(sl, snl) + ',' + Math.max(sl, snl);
            sharedBoundaries[sbk] = (sharedBoundaries[sbk] || 0) + 1;
          }
        }
      }
    }

    return {
      engine: 'wfg3',
      version: 1,
      parameters: copyParams(p),
      pipelineMode: p.pipelineMode || 'partition',
      normalizedSize: { width: w, height: h },

      nodes: nodes,
      edges: edges,
      partition: {
        regionCount: partition.regionCount,
        adjacency: partition.adjacency
      },

      artifacts: {
        // WFG3-specific Stage B artifacts
        wfg3_edgeBinary: evidence.edgeBinary,
        wfg3_edgeWeighted: evidence.edgeWeighted,
        wfg3_gradMag: evidence.gradMag,
        wfg3_labDelta: evidence.labDelta,
        wfg3_contourCount: evidence.contourCount,

        // WFG3-specific Stage C artifacts
        wfg3_tokens: tokens,
        wfg3_tokenCount: tokens.length,

        // WFG3-specific Stage D artifacts
        wfg3_boundaryGraph: boundaryGraph,
        wfg3_chainCount: boundaryGraph.chains.length,
        wfg3_loopCount: boundaryGraph.loops.length,
        wfg3_chainMask: boundaryGraph.chainMask,

        // WFG3-specific Stage E artifacts
        wfg3_labelMap: partition.labelMap,
        wfg3_regionCount: partition.regionCount,
        wfg3_regionStats: partition.stats,
        wfg3_regionBoundaries: partition.boundaries,

        // WFG3-specific Stage F artifacts
        wfg3_groupLabelMap: groupMap.labelMap,
        wfg3_groupCount: groupMap.groupCount,
        wfg3_groups: groupMap.groups,
        wfg3_groupBoundaries: groupMap.boundaries,

        // Backend indicator
        wfg3_backend: CV.hasOpenCV() ? 'OpenCV.js' : 'pure-JS',

        // WFG2-compat artifacts (so app's grouped-graph path works)
        partitionLabelMap: partition.labelMap,
        partitionSharedBoundaries: sharedBoundaries,
        partitionRegionMeans: regionMeans,

        // Flags the app may check
        colorBoundaryActive: !!(normalizedSurface.lab),
        closureActive: true,
        enclosedRegionCount: partition.regionCount,
        nocolourFallbackActive: false,

        // Null out WFG2-only artifacts
        colorBoundaryMap: null,
        closureMap: null,
        nocolourDebug: null,
        combinedEvidenceMap: null
      }
    };
  }

  /* ── APIs the app calls for grouping ── */

  function adaptParametersFromFeedback(params, feedback) {
    return copyParams(params || DEFAULT_PARAMS);
  }

  /**
   * computeGroupedGraph — app calls this after generateFeatureGraph
   * to get grouping info.  WFG3 already computed groups in Stage F,
   * so we re-expose Stage F results in the shape the app expects.
   */
  function computeGroupedGraph(partResult, opts) {
    if (!partResult || !partResult.labelMap) return null;
    var w = opts.width, h = opts.height;
    var threshold = opts.mergeThreshold != null ? opts.mergeThreshold : 0.45;

    // If we have cached Stage F group data on the artifacts, use it directly.
    // The app may call this with a different mergeThreshold from the slider,
    // so re-run Stage F with the adjusted threshold.
    var surface = _lastSurface; // captured during generateFeatureGraph
    if (!surface) return null;

    var partition = {
      kind: 'wfg3-region-partition',
      width: w, height: h,
      labelMap: partResult.labelMap,
      regionCount: partResult.regionCount,
      stats: _lastPartitionStats || {},
      adjacency: partResult.adjacency || {},
      boundaries: new Uint8Array(0) // not needed for re-group
    };

    var cfgDF = Object.assign({}, Stages.DEFAULT_CONFIG_DF, { groupMergeThreshold: threshold });
    var groupMap = Stages.stageF(partition, surface, cfgDF);

    // Shape result as the app expects from WFG2's computeGroupedGraph
    var groupNodes = [];
    for (var gid in groupMap.groups) {
      var g = groupMap.groups[gid];
      groupNodes.push({
        id: +gid,
        regionIds: g.regionIds,
        area: g.area,
        cx: g.cx, cy: g.cy,
        bbox: { x: g.bboxX, y: g.bboxY, w: g.bboxW, h: g.bboxH }
      });
    }

    return {
      engine: 'wfg3',
      groupCount: groupMap.groupCount,
      groups: groupNodes,
      labelMap: groupMap.labelMap,
      boundaries: groupMap.boundaries
    };
  }

  /**
   * buildGroupedLabelMap — builds a fused label map from partition + grouped graph
   */
  function buildGroupedLabelMap(partitionLabelMap, groupedGraph, nodes) {
    if (!partitionLabelMap || !groupedGraph || !groupedGraph.labelMap) return null;
    return {
      groupedLabelMap: groupedGraph.labelMap
    };
  }

  /**
   * computeSharedBoundaries — boundary pixel mask between groups
   */
  function computeSharedBoundaries(labelMap, w, h) {
    if (!labelMap || !w || !h) return null;
    var n = w * h;
    var boundaries = new Uint8Array(n);
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var l = labelMap[y * w + x];
        for (var d = 0; d < 4; d++) {
          var nx = x + dx4[d], ny = y + dy4[d];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (labelMap[ny * w + nx] !== l) { boundaries[y * w + x] = 255; break; }
        }
      }
    }
    return boundaries;
  }

  // Internal state: capture the surface and partition stats during generateFeatureGraph
  // so computeGroupedGraph can re-run Stage F with adjusted thresholds.
  var _lastSurface = null;
  var _lastPartitionStats = null;

  function createAttemptStore(storage) {
    var KEY = 'wfg3.attempts.v1';
    return {
      getAll: function () {
        try { return JSON.parse(storage.getItem(KEY) || '[]'); } catch (e) { return []; }
      },
      addAttempt: function (a) {
        var all = this.getAll(); all.push(a);
        try { storage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
      },
      clear: function () { try { storage.removeItem(KEY); } catch (e) { /* */ } }
    };
  }

  function createPresetStore(storage) {
    var KEY = 'wfg3.preset.v1';
    return {
      get: function () {
        try {
          var raw = JSON.parse(storage.getItem(KEY) || 'null');
          if (raw && raw._schemaVersion === DEFAULT_PARAMS._schemaVersion) return raw;
          return null;
        } catch (e) { return null; }
      },
      save: function (preset) {
        try { storage.setItem(KEY, JSON.stringify(preset)); } catch (e) { /* */ }
      },
      clear: function () { try { storage.removeItem(KEY); } catch (e) { /* */ } }
    };
  }

  /* ── Public API ── */

  global.WrokitFeatureGraph3 = {
    ENGINE_KEY: 'wfg3',
    ENGINE_LABEL: 'WFG3',
    DEFAULT_PARAMS: DEFAULT_PARAMS,

    copyParams: copyParams,
    normalizeVisualInput: normalizeVisualInput,
    generateFeatureGraph: generateFeatureGraph,
    adaptParametersFromFeedback: adaptParametersFromFeedback,
    computeGroupedGraph: computeGroupedGraph,
    buildGroupedLabelMap: buildGroupedLabelMap,
    computeSharedBoundaries: computeSharedBoundaries,
    createAttemptStore: createAttemptStore,
    createPresetStore: createPresetStore
  };

})(typeof window !== 'undefined' ? window : globalThis);
