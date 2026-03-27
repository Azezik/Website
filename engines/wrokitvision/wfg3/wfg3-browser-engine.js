/**
 * WFG3 Browser Engine — stand-alone, no WFG2 dependency.
 *
 * Runs the real WFG3 pipeline (Stages A–C implemented, D–H stubbed)
 * using wfg3-cv.js and wfg3-stages-ac.js as the substrate.
 *
 * Exposes window.WrokitFeatureGraph3 with the same public API shape
 * that the Wrokit app expects from a graph learning engine.
 *
 * Depends on: wfg3-cv.js, wfg3-stages-ac.js (must be loaded first)
 */
(function (global) {
  'use strict';

  var CV = global._WFG3_CV;
  var Stages = global._WFG3_Stages;
  if (!CV) throw new Error('wfg3-browser-engine.js requires wfg3-cv.js');
  if (!Stages) throw new Error('wfg3-browser-engine.js requires wfg3-stages-ac.js');

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

  /* ── Stages B+C: generateFeatureGraph ── */

  function generateFeatureGraph(normalizedSurface, params) {
    if (!normalizedSurface) return null;
    var p = params || DEFAULT_PARAMS;
    var cfg = Object.assign({}, Stages.DEFAULT_CONFIG_AC, p);

    var w = normalizedSurface.width;
    var h = normalizedSurface.height;
    var n = w * h;

    // Run Stage B
    var evidence = Stages.stageB(normalizedSurface, cfg);

    // Run Stage C
    var tokens = Stages.stageC(normalizedSurface, evidence, cfg);

    // Build a graph result shaped for the app's render path.
    // Stages D–H are not yet implemented, so nodes/edges/partition are
    // minimal stubs.  The real data lives in artifacts.wfg3_*.

    var nodes = [];
    var edges = [];

    // Create one pseudo-node per connected edge segment so the app's
    // node renderer has something to show.  This is honest: we label
    // them as WFG3 boundary segments, not fake regions.
    // (Kept minimal — real region nodes arrive in Phase 3.)

    return {
      engine: 'wfg3',
      version: 1,
      parameters: copyParams(p),
      pipelineMode: p.pipelineMode || 'partition',
      normalizedSize: { width: w, height: h },

      nodes: nodes,
      edges: edges,
      partition: null,   // Phase 3

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

        // Backend indicator
        wfg3_backend: CV.hasOpenCV() ? 'OpenCV.js' : 'pure-JS',

        // Flags the app may check
        colorBoundaryActive: !!(normalizedSurface.lab),
        closureActive: false,
        enclosedRegionCount: 0,
        nocolourFallbackActive: false,

        // Null out WFG2 artifacts so old render paths skip gracefully
        colorBoundaryMap: null,
        closureMap: null,
        partitionLabelMap: null,
        partitionSharedBoundaries: null,
        partitionRegionMeans: null,
        nocolourDebug: null,
        combinedEvidenceMap: null
      }
    };
  }

  /* ── Stubs for APIs the app may call ── */

  function adaptParametersFromFeedback(params, feedback) {
    // Minimal: return params unchanged.  Real feedback adaptation
    // will be added when Stages D–F land and there are meaningful
    // parameters to tune.
    return copyParams(params || DEFAULT_PARAMS);
  }

  // Grouped graph operations are Phase 3.  Return null so the app
  // gracefully skips grouped rendering.
  function computeGroupedGraph() { return null; }
  function buildGroupedLabelMap() { return null; }
  function computeSharedBoundaries() { return null; }

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
