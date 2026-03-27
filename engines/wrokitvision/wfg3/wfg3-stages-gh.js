/**
 * WFG3 Stages G–H  (Phase 4)
 *
 * Stage G: Structure Graph — infers spatial relationships between groups
 * Stage H: Debug Visualization — generates in-memory overlay images
 *
 * Depends on: wfg3-cv.js (window._WFG3_CV)
 * Extends:    window._WFG3_Stages  (adds stageG, stageH)
 */
(function (global) {
  'use strict';

  var CV = global._WFG3_CV;
  var Stages = global._WFG3_Stages;
  if (!CV) throw new Error('wfg3-stages-gh.js requires wfg3-cv.js');
  if (!Stages) throw new Error('wfg3-stages-gh.js requires wfg3-stages-ac.js');

  /**
   * Stage G contract: StructureGraph
   * {
   *   kind:  'wfg3-structure-graph',
   *   nodes: { groupId → { area, cx, cy, bboxX, bboxY, bboxW, bboxH } },
   *   edges: [ { src, dst, type } ],
   *   edgesByType: { type → [ { src, dst, type } ] }
   * }
   *
   * Edge types: 'adjacent', 'containment', 'alignment_horizontal',
   *             'alignment_vertical', 'support', 'repetition'
   *
   * Stage H contract: DebugArtifacts
   * {
   *   kind:     'wfg3-debug-artifacts',
   *   overlays: { name → ImageData }
   * }
   */

  /* ── Default config for Stages G–H ── */

  var DEFAULT_CONFIG_GH = Object.freeze({
    // Stage G
    alignmentThresholdPx:  8,
    supportGapMaxPx:       20,
    repetitionSizeRatio:   1.25,
    repetitionMaxDistPx:   220,
    containmentOverlap:    0.90,

    // Stage H
    debugTokenStride:      8,
    debugGraphStride:      12,
    debugNodeRadius:       4
  });

  /* ==================================================================
   *  Stage G: Structure Graph
   * ================================================================== */

  function stageG_structureGraph(groupMap, cfg) {
    cfg = cfg || DEFAULT_CONFIG_GH;
    var W = groupMap.width, H = groupMap.height;
    var groups = groupMap.groups;
    var labelMap = groupMap.labelMap;
    var groupCount = groupMap.groupCount;

    // ── 1. Extract node properties ──
    var nodes = {};
    var groupIds = [];
    for (var gid in groups) {
      var g = groups[gid];
      groupIds.push(+gid);
      nodes[+gid] = {
        area: g.area,
        cx: g.cx, cy: g.cy,
        bboxX: g.bboxX, bboxY: g.bboxY,
        bboxW: g.bboxW, bboxH: g.bboxH
      };
    }

    // ── 2. Build per-group pixel masks for adjacency/containment ──
    // Use a scan-line approach: collect row spans per group
    var groupRows = {}; // gid → { minY, maxY, rows: { y → [minX, maxX] } }
    for (var gi = 0; gi < groupIds.length; gi++) {
      var id = groupIds[gi];
      var nd = nodes[id];
      groupRows[id] = {
        minY: nd.bboxY, maxY: nd.bboxY + nd.bboxH,
        minX: nd.bboxX, maxX: nd.bboxX + nd.bboxW
      };
    }

    // ── 3. Detect edges ──
    var edges = [];
    var edgesByType = {
      adjacent: [],
      containment: [],
      alignment_horizontal: [],
      alignment_vertical: [],
      support: [],
      repetition: []
    };

    // Pre-compute adjacency from label map (dilate-check)
    var adjPairs = {};
    var dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    var dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
    for (var ay = 0; ay < H; ay++) {
      for (var ax = 0; ax < W; ax++) {
        var al = labelMap[ay * W + ax];
        if (al <= 0) continue;
        for (var ad = 0; ad < 8; ad++) {
          var anx = ax + dx8[ad], any2 = ay + dy8[ad];
          if (anx < 0 || anx >= W || any2 < 0 || any2 >= H) continue;
          var bl = labelMap[any2 * W + anx];
          if (bl > 0 && bl !== al) {
            var apk = Math.min(al, bl) + ',' + Math.max(al, bl);
            adjPairs[apk] = true;
          }
        }
      }
    }

    // Emit adjacency edges
    for (var apk2 in adjPairs) {
      var parts = apk2.split(',');
      var e = { src: +parts[0], dst: +parts[1], type: 'adjacent' };
      edges.push(e);
      edgesByType.adjacent.push(e);
    }

    // Pairwise checks for other edge types
    for (var i = 0; i < groupIds.length; i++) {
      var idA = groupIds[i];
      var na = nodes[idA];
      if (!na || na.area === 0) continue;

      for (var j = i + 1; j < groupIds.length; j++) {
        var idB = groupIds[j];
        var nb = nodes[idB];
        if (!nb || nb.area === 0) continue;

        // ── Containment ──
        // Check bbox overlap; if one bbox fully contains the other
        var overlapX = Math.max(0,
          Math.min(na.bboxX + na.bboxW, nb.bboxX + nb.bboxW) -
          Math.max(na.bboxX, nb.bboxX));
        var overlapY = Math.max(0,
          Math.min(na.bboxY + na.bboxH, nb.bboxY + nb.bboxH) -
          Math.max(na.bboxY, nb.bboxY));
        var overlapArea = overlapX * overlapY;
        var smallerArea = Math.min(na.area, nb.area);
        var smallerBboxArea = Math.min(na.bboxW * na.bboxH, nb.bboxW * nb.bboxH);
        if (smallerBboxArea > 0 && overlapArea / smallerBboxArea > cfg.containmentOverlap) {
          var ec = { src: na.area > nb.area ? idA : idB, dst: na.area > nb.area ? idB : idA, type: 'containment' };
          edges.push(ec);
          edgesByType.containment.push(ec);
        }

        // ── Alignment Horizontal (similar Y centroid) ──
        if (Math.abs(na.cy - nb.cy) < cfg.alignmentThresholdPx) {
          var eah = { src: idA, dst: idB, type: 'alignment_horizontal' };
          edges.push(eah);
          edgesByType.alignment_horizontal.push(eah);
        }

        // ── Alignment Vertical (similar X centroid) ──
        if (Math.abs(na.cx - nb.cx) < cfg.alignmentThresholdPx) {
          var eav = { src: idA, dst: idB, type: 'alignment_vertical' };
          edges.push(eav);
          edgesByType.alignment_vertical.push(eav);
        }

        // ── Support (B below A with horizontal overlap) ──
        var xOverlap = Math.max(0,
          Math.min(na.bboxX + na.bboxW, nb.bboxX + nb.bboxW) -
          Math.max(na.bboxX, nb.bboxX));
        if (xOverlap > 0) {
          // Check if A is above B
          var aBottom = na.bboxY + na.bboxH;
          var bTop = nb.bboxY;
          var bBottom = nb.bboxY + nb.bboxH;
          var aTop = na.bboxY;

          if (na.cy < nb.cy) {
            // A above B
            var gap = bTop - aBottom;
            if (gap >= 0 && gap < cfg.supportGapMaxPx) {
              var es1 = { src: idA, dst: idB, type: 'support' };
              edges.push(es1);
              edgesByType.support.push(es1);
            }
          } else {
            // B above A
            var gap2 = aTop - bBottom;
            if (gap2 >= 0 && gap2 < cfg.supportGapMaxPx) {
              var es2 = { src: idB, dst: idA, type: 'support' };
              edges.push(es2);
              edgesByType.support.push(es2);
            }
          }
        }

        // ── Repetition (similar size + spatially close) ──
        var sizeRatio = Math.max(na.area, nb.area) / Math.max(1, Math.min(na.area, nb.area));
        var dist = Math.sqrt(
          (na.cx - nb.cx) * (na.cx - nb.cx) +
          (na.cy - nb.cy) * (na.cy - nb.cy)
        );
        if (sizeRatio < cfg.repetitionSizeRatio && dist < cfg.repetitionMaxDistPx) {
          var er = { src: idA, dst: idB, type: 'repetition' };
          edges.push(er);
          edgesByType.repetition.push(er);
        }
      }
    }

    return {
      kind: 'wfg3-structure-graph',
      nodes: nodes,
      edges: edges,
      edgesByType: edgesByType
    };
  }

  /* ==================================================================
   *  Stage H: Debug Visualization
   * ================================================================== */

  /**
   * Generate in-memory overlay ImageData objects for each pipeline stage.
   * In the browser, these are canvas-renderable ImageData, not PNGs.
   * The app's overlay renderer can composite them onto the viewport.
   */
  function stageH_debugViz(surface, evidence, tokens, graph, partition, groupMap, structureGraph, cfg) {
    cfg = cfg || DEFAULT_CONFIG_GH;
    var W = surface.width, H = surface.height, N = W * H;
    var overlays = {};

    // ── Overlay 1: edge_map ──
    var edgeOv = new Uint8ClampedArray(N * 4);
    if (evidence && evidence.edgeBinary) {
      var eb = evidence.edgeBinary;
      for (var ei = 0, ej = 0; ei < N; ei++, ej += 4) {
        if (eb[ei] > 0) {
          edgeOv[ej] = 0; edgeOv[ej + 1] = 255; edgeOv[ej + 2] = 100; edgeOv[ej + 3] = 220;
        }
      }
    }
    overlays.edge_map = { width: W, height: H, data: edgeOv };

    // ── Overlay 2: boundary_tokens ──
    // Stored as drawing commands (canvas-rendered in the overlay painter)
    var tokenCmds = [];
    if (tokens && tokens.length > 0) {
      var stride = cfg.debugTokenStride;
      for (var ti = 0; ti < tokens.length; ti += stride) {
        var tok = tokens[ti];
        tokenCmds.push({
          x: tok.x, y: tok.y,
          tx: tok.tangentX, ty: tok.tangentY,
          nx: tok.normalX, ny: tok.normalY,
          conf: tok.confidence
        });
      }
    }
    overlays.boundary_tokens = { kind: 'commands', commands: tokenCmds };

    // ── Overlay 3: boundary_graph ──
    var graphCmds = [];
    if (tokens && graph && graph.adjacency) {
      var tokenById = {};
      for (var gi = 0; gi < tokens.length; gi++) tokenById[tokens[gi].id] = tokens[gi];
      var gStride = cfg.debugGraphStride;
      var drawnEdges = {};
      for (var gj = 0; gj < tokens.length; gj += gStride) {
        var gtok = tokens[gj];
        var neis = graph.adjacency[gtok.id];
        if (!neis) continue;
        for (var gk = 0; gk < neis.length; gk++) {
          if (neis[gk] < gtok.id) continue; // draw each edge once
          var ntok = tokenById[neis[gk]];
          if (!ntok) continue;
          var ekey = gtok.id + ',' + neis[gk];
          if (drawnEdges[ekey]) continue;
          drawnEdges[ekey] = true;
          graphCmds.push({
            x1: gtok.x, y1: gtok.y,
            x2: ntok.x, y2: ntok.y
          });
        }
      }
    }
    overlays.boundary_graph = { kind: 'commands', commands: graphCmds };

    // ── Overlay 4: region_map ──
    var regionOv = new Uint8ClampedArray(N * 4);
    if (partition && partition.labelMap) {
      var rlm = partition.labelMap;
      var rrc = partition.regionCount || 0;
      for (var ri = 0, rj = 0; ri < N; ri++, rj += 4) {
        var rl = rlm[ri];
        if (rl > 0) {
          var rhue = (rl * 137.508) % 360;
          var rgb = _hslToRgb(rhue, 0.85, 0.5);
          regionOv[rj] = rgb[0]; regionOv[rj + 1] = rgb[1]; regionOv[rj + 2] = rgb[2];
          regionOv[rj + 3] = 140;
        }
      }
    }
    overlays.region_map = { width: W, height: H, data: regionOv };

    // ── Overlay 5: group_map ──
    var groupOv = new Uint8ClampedArray(N * 4);
    if (groupMap && groupMap.labelMap) {
      var glm = groupMap.labelMap;
      for (var gi2 = 0, gj2 = 0; gi2 < N; gi2++, gj2 += 4) {
        var gl = glm[gi2];
        if (gl > 0) {
          var ghue = (gl * 137.508 + 60) % 360; // offset from region colors
          var grgb = _hslToRgb(ghue, 0.9, 0.55);
          groupOv[gj2] = grgb[0]; groupOv[gj2 + 1] = grgb[1]; groupOv[gj2 + 2] = grgb[2];
          groupOv[gj2 + 3] = 160;
        }
      }
    }
    overlays.group_map = { width: W, height: H, data: groupOv };

    // ── Overlay 6: structure_graph ──
    // Stored as drawing commands (nodes + edges for canvas rendering)
    var sgCmds = { nodes: [], edges: [] };
    if (structureGraph) {
      var sgNodes = structureGraph.nodes;
      var sgEdges = structureGraph.edges;

      for (var nid in sgNodes) {
        var sn = sgNodes[nid];
        sgCmds.nodes.push({
          id: +nid, x: sn.cx, y: sn.cy,
          bboxX: sn.bboxX, bboxY: sn.bboxY,
          bboxW: sn.bboxW, bboxH: sn.bboxH
        });
      }

      // Edge type → color mapping
      var typeColors = {
        adjacent: [255, 165, 0],      // orange
        containment: [255, 0, 0],     // red
        alignment_horizontal: [0, 200, 255], // light blue
        alignment_vertical: [180, 0, 255],   // purple
        support: [0, 255, 128],       // spring green
        repetition: [255, 255, 0]     // yellow
      };

      for (var sei = 0; sei < sgEdges.length; sei++) {
        var se = sgEdges[sei];
        var srcN = sgNodes[se.src];
        var dstN = sgNodes[se.dst];
        if (!srcN || !dstN) continue;
        sgCmds.edges.push({
          x1: srcN.cx, y1: srcN.cy,
          x2: dstN.cx, y2: dstN.cy,
          type: se.type,
          color: typeColors[se.type] || [200, 200, 200]
        });
      }
    }
    overlays.structure_graph = { kind: 'commands', data: sgCmds };

    return {
      kind: 'wfg3-debug-artifacts',
      overlays: overlays
    };
  }

  /* ── Helper: HSL → RGB ── */
  function _hslToRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r, g, b;
    var hs = (h / 60) | 0;
    if (hs === 0) { r = c; g = x; b = 0; }
    else if (hs === 1) { r = x; g = c; b = 0; }
    else if (hs === 2) { r = 0; g = c; b = x; }
    else if (hs === 3) { r = 0; g = x; b = c; }
    else if (hs === 4) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255)
    ];
  }

  /* ── Extend public API ── */

  Stages.DEFAULT_CONFIG_GH = DEFAULT_CONFIG_GH;
  Stages.stageG = stageG_structureGraph;
  Stages.stageH = stageH_debugViz;

})(typeof window !== 'undefined' ? window : globalThis);
