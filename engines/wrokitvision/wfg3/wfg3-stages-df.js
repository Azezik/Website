/**
 * WFG3 Stages D–F  (Phase 3)
 *
 * Stage D: Boundary Graph Assembly
 * Stage E: Region Partition
 * Stage F: Region Grouping
 *
 * Depends on: wfg3-cv.js (window._WFG3_CV)
 * Extends:    window._WFG3_Stages  (adds stageD, stageE, stageF)
 */
(function (global) {
  'use strict';

  var CV = global._WFG3_CV;
  var Stages = global._WFG3_Stages;
  if (!CV) throw new Error('wfg3-stages-df.js requires wfg3-cv.js');
  if (!Stages) throw new Error('wfg3-stages-df.js requires wfg3-stages-ac.js');

  /**
   * Stage D contract: BoundaryGraph
   * {
   *   kind:      'wfg3-boundary-graph',
   *   adjacency: { tokenId → [tokenId] },
   *   chains:    [ { ids: [tokenId], ordered: boolean } ],
   *   loops:     [ { ids: [tokenId] } ],
   *   chainMask: Uint8Array (w*h, pixels on any chain = 255)
   * }
   *
   * Stage E contract: RegionPartition
   * {
   *   kind:        'wfg3-region-partition',
   *   width:       number,
   *   height:      number,
   *   labelMap:    Int32Array (w*h, every pixel labeled 1..regionCount),
   *   regionCount: number,
   *   stats:       { regionId → { area, bboxX, bboxY, bboxW, bboxH, cx, cy } },
   *   adjacency:   { regionId → Set<regionId> },
   *   boundaries:  Uint8Array (w*h, boundary pixels = 255)
   * }
   *
   * Stage F contract: GroupMap
   * {
   *   kind:       'wfg3-group-map',
   *   width:      number,
   *   height:     number,
   *   labelMap:   Int32Array (w*h, group labels),
   *   groupCount: number,
   *   groups:     { groupId → { regionIds, area, cx, cy, bboxX, bboxY, bboxW, bboxH } },
   *   boundaries: Uint8Array (w*h, group boundary pixels = 255)
   * }
   */

  /* ── Default config for Stages D–F ── */

  var DEFAULT_CONFIG_DF = Object.freeze({
    // Stage D
    graphNeighborRadius:   4,
    graphOrientationTolDeg: 35,
    graphSideDeltaETol:    25,
    chainMinLength:        3,

    // Stage D: Pass-2 Bridging
    bridgeEnabled:          true,
    bridgeMaxGapPx:         18,
    bridgeMinEvidenceScore: 0.25,
    bridgeDirAgreementMin:  0.50,
    bridgeSideDeltaETol:    30,
    bridgeStructuralBonus:  0.15,

    // Stage E
    watershedFgFraction:   0.25,
    minRegionArea:         24,
    boundaryBoostWeight:   0.4,

    // Stage F
    groupMergeThreshold:   0.45,
    groupMinPerimeterRatio: 0.15
  });

  /* ==================================================================
   *  Stage D: Boundary Graph Assembly
   * ================================================================== */

  function stageD_boundaryGraph(tokens, evidence, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    var W = evidence.width, H = evidence.height;
    var radius = cfg.graphNeighborRadius;
    var angleTolCos = Math.cos(cfg.graphOrientationTolDeg * Math.PI / 180);
    var sideTol = cfg.graphSideDeltaETol;

    // Spatial index: bin tokens by grid cell for fast neighbor lookup
    var cellSize = radius + 1;
    var grid = {};
    for (var ti = 0; ti < tokens.length; ti++) {
      var t = tokens[ti];
      var gx = (t.x / cellSize) | 0;
      var gy = (t.y / cellSize) | 0;
      var key = gx + ',' + gy;
      if (!grid[key]) grid[key] = [];
      grid[key].push(t);
    }

    // Build adjacency (Pass 1: strict local graph)
    var adjacency = {};
    for (var ai = 0; ai < tokens.length; ai++) adjacency[tokens[ai].id] = [];

    for (var bi = 0; bi < tokens.length; bi++) {
      var a = tokens[bi];
      var ax = (a.x / cellSize) | 0;
      var ay = (a.y / cellSize) | 0;

      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nk = (ax + dx) + ',' + (ay + dy);
          var cell = grid[nk];
          if (!cell) continue;
          for (var ci = 0; ci < cell.length; ci++) {
            var b = cell[ci];
            if (b.id <= a.id) continue; // undirected, avoid duplicates
            var ddx = b.x - a.x, ddy = b.y - a.y;
            if (Math.abs(ddx) > radius || Math.abs(ddy) > radius) continue;
            if (ddx * ddx + ddy * ddy > radius * radius) continue;

            // Orientation consistency: tangent dot product
            var dot = a.tangentX * b.tangentX + a.tangentY * b.tangentY;
            if (Math.abs(dot) < angleTolCos) continue;

            // Side consistency: left-left and right-right LAB distance
            var llDist = _labDist(a.leftLab, b.leftLab);
            var rrDist = _labDist(a.rightLab, b.rightLab);
            var lrDist = _labDist(a.leftLab, b.rightLab);
            var rlDist = _labDist(a.rightLab, b.leftLab);
            var sameOK = llDist <= sideTol && rrDist <= sideTol;
            var flipOK = lrDist <= sideTol && rlDist <= sideTol;
            if (!sameOK && !flipOK) continue;

            adjacency[a.id].push(b.id);
            adjacency[b.id].push(a.id);
          }
        }
      }
    }

    // Find connected components via BFS
    var visited = {};
    var components = [];
    for (var vi = 0; vi < tokens.length; vi++) {
      var tid = tokens[vi].id;
      if (visited[tid]) continue;
      var comp = [];
      var queue = [tid];
      visited[tid] = true;
      while (queue.length > 0) {
        var cur = queue.shift();
        comp.push(cur);
        var neis = adjacency[cur];
        for (var ni = 0; ni < neis.length; ni++) {
          if (!visited[neis[ni]]) {
            visited[neis[ni]] = true;
            queue.push(neis[ni]);
          }
        }
      }
      if (comp.length >= cfg.chainMinLength) {
        components.push(comp);
      }
    }

    // Order each chain spatially for meaningful chain structure
    var tokenById = {};
    for (var oi = 0; oi < tokens.length; oi++) tokenById[tokens[oi].id] = tokens[oi];

    var chains = [];
    var loops = [];

    for (var ki = 0; ki < components.length; ki++) {
      var comp2 = components[ki];
      var ordered = _orderChain(comp2, adjacency, tokenById);

      // Detect loop: if the first and last token in the ordered chain are
      // connected and the component has no degree-1 nodes
      var isLoop = false;
      if (ordered.length >= 6) {
        var first = ordered[0], last = ordered[ordered.length - 1];
        var firstNeis = adjacency[first];
        if (firstNeis.indexOf(last) >= 0) {
          // Check if all nodes have degree >= 2
          var allDeg2 = true;
          for (var li = 0; li < ordered.length; li++) {
            var deg = 0;
            var tokNeis = adjacency[ordered[li]];
            for (var lj = 0; lj < tokNeis.length; lj++) {
              if (comp2.indexOf(tokNeis[lj]) >= 0) deg++;
            }
            if (deg < 2) { allDeg2 = false; break; }
          }
          isLoop = allDeg2;
        }
      }

      chains.push({ ids: ordered, ordered: true });
      if (isLoop) loops.push({ ids: ordered });
    }

    /* ================================================================
     *  Pass 2: Bridge Candidates
     *  Scan chain endpoints for pairings across larger gaps.
     * ================================================================ */

    var bridgeEdgeList = [];
    var bridgesEvaluated = 0;
    var bridgesAccepted = 0;

    if (cfg.bridgeEnabled && chains.length > 1) {
      var bridgeResult = _bridgePass(
        chains, loops, adjacency, tokenById, evidence, cfg, W, H
      );
      bridgeEdgeList = bridgeResult.bridgeEdgeList;
      bridgesEvaluated = bridgeResult.bridgesEvaluated;
      bridgesAccepted = bridgeResult.bridgesAccepted;

      // Re-discover components after bridging to merge chains
      if (bridgesAccepted > 0) {
        visited = {};
        components = [];
        for (var vi2 = 0; vi2 < tokens.length; vi2++) {
          var tid2 = tokens[vi2].id;
          if (visited[tid2]) continue;
          var comp3 = [];
          var queue2 = [tid2];
          visited[tid2] = true;
          while (queue2.length > 0) {
            var cur2 = queue2.shift();
            comp3.push(cur2);
            var neis2 = adjacency[cur2];
            for (var ni2 = 0; ni2 < neis2.length; ni2++) {
              if (!visited[neis2[ni2]]) {
                visited[neis2[ni2]] = true;
                queue2.push(neis2[ni2]);
              }
            }
          }
          if (comp3.length >= cfg.chainMinLength) {
            components.push(comp3);
          }
        }

        // Re-order and re-detect loops on merged chains
        chains = [];
        loops = [];
        for (var ki2 = 0; ki2 < components.length; ki2++) {
          var comp4 = components[ki2];
          var ordered2 = _orderChain(comp4, adjacency, tokenById);
          var isLoop2 = false;
          if (ordered2.length >= 6) {
            var first2 = ordered2[0], last2 = ordered2[ordered2.length - 1];
            if (adjacency[first2].indexOf(last2) >= 0) {
              var allDeg2b = true;
              for (var li2 = 0; li2 < ordered2.length; li2++) {
                var deg2 = 0;
                var tokNeis2 = adjacency[ordered2[li2]];
                for (var lj2 = 0; lj2 < tokNeis2.length; lj2++) {
                  if (comp4.indexOf(tokNeis2[lj2]) >= 0) deg2++;
                }
                if (deg2 < 2) { allDeg2b = false; break; }
              }
              isLoop2 = allDeg2b;
            }
          }
          chains.push({ ids: ordered2, ordered: true });
          if (isLoop2) loops.push({ ids: ordered2 });
        }
      }
    }

    /* ================================================================
     *  Rasterized Chain Mask (Bresenham line drawing)
     *  Replaces the old isolated-dots mask with actual line segments.
     * ================================================================ */

    var chainMask = new Uint8Array(W * H);
    for (var mi = 0; mi < chains.length; mi++) {
      var ch = chains[mi].ids;
      for (var mj = 0; mj < ch.length; mj++) {
        var mt = tokenById[ch[mj]];
        if (!mt) continue;
        // Mark the token pixel itself
        chainMask[mt.y * W + mt.x] = 255;
        // Draw a line segment to the next token in the ordered chain
        if (mj + 1 < ch.length) {
          var mt2 = tokenById[ch[mj + 1]];
          if (mt2) _bresenhamLine(chainMask, W, H, mt.x, mt.y, mt2.x, mt2.y);
        }
      }
      // If this chain is a loop, also connect last to first
      if (ch.length >= 6) {
        var loopFirst = tokenById[ch[0]];
        var loopLast = tokenById[ch[ch.length - 1]];
        if (loopFirst && loopLast) {
          var loopIdx = -1;
          for (var lci = 0; lci < loops.length; lci++) {
            if (loops[lci].ids === ch) { loopIdx = lci; break; }
          }
          if (loopIdx >= 0) {
            _bresenhamLine(chainMask, W, H, loopLast.x, loopLast.y, loopFirst.x, loopFirst.y);
          }
        }
      }
    }

    return {
      kind: 'wfg3-boundary-graph',
      adjacency: adjacency,
      chains: chains,
      loops: loops,
      chainMask: chainMask,
      bridgeEdgeList: bridgeEdgeList,
      bridgesEvaluated: bridgesEvaluated,
      bridgesAccepted: bridgesAccepted
    };
  }

  /* ── LAB distance helper ── */

  function _labDist(lab1, lab2) {
    var dL = lab1[0] - lab2[0];
    var da = lab1[1] - lab2[1];
    var db = lab1[2] - lab2[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  /* ── Bresenham integer line rasterizer ── */

  function _bresenhamLine(mask, W, H, x0, y0, x1, y1) {
    x0 = x0 | 0; y0 = y0 | 0; x1 = x1 | 0; y1 = y1 | 0;
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1;
    var sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    while (true) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) {
        mask[y0 * W + x0] = 255;
      }
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  /* ================================================================
   *  Pass 2: Bridge candidate evaluation and acceptance
   * ================================================================ */

  function _bridgePass(chains, loops, adjacency, tokenById, evidence, cfg, W, H) {
    var maxGap = cfg.bridgeMaxGapPx;
    var minEvidence = cfg.bridgeMinEvidenceScore;
    var dirMin = cfg.bridgeDirAgreementMin;
    var bridgeSideTol = cfg.bridgeSideDeltaETol;
    var structBonus = cfg.bridgeStructuralBonus;
    var edgeW = evidence.edgeWeighted;
    var gradMag = evidence.gradMag;

    // Identify chain endpoints (first/last token in each non-loop chain)
    var loopSet = {};
    for (var lsi = 0; lsi < loops.length; lsi++) {
      var loopIds = loops[lsi].ids;
      for (var lsj = 0; lsj < loopIds.length; lsj++) loopSet[loopIds[lsj]] = true;
    }

    var endpoints = []; // { token, chainIdx, isFirst }
    for (var ei = 0; ei < chains.length; ei++) {
      var ch = chains[ei].ids;
      if (ch.length < 2) continue;
      var firstId = ch[0], lastId = ch[ch.length - 1];
      // Skip endpoints that are part of loops (already closed)
      if (loopSet[firstId] && loopSet[lastId]) continue;
      var firstTok = tokenById[firstId];
      var lastTok = tokenById[lastId];
      if (firstTok) endpoints.push({ token: firstTok, chainIdx: ei, isFirst: true });
      if (lastTok) endpoints.push({ token: lastTok, chainIdx: ei, isFirst: false });
    }

    // Build spatial index for endpoints using bridgeMaxGapPx cells
    var epCellSize = maxGap + 1;
    var epGrid = {};
    for (var gi = 0; gi < endpoints.length; gi++) {
      var ep = endpoints[gi];
      var egx = (ep.token.x / epCellSize) | 0;
      var egy = (ep.token.y / epCellSize) | 0;
      var epKey = egx + ',' + egy;
      if (!epGrid[epKey]) epGrid[epKey] = [];
      epGrid[epKey].push(ep);
    }

    // Normalize gradMag for corridor evidence scoring
    var maxGrad = 0;
    var N = W * H;
    for (var gmi = 0; gmi < N; gmi++) {
      if (gradMag[gmi] > maxGrad) maxGrad = gradMag[gmi];
    }
    var gradNorm = maxGrad > 0 ? 1.0 / maxGrad : 0;

    var bridgesEvaluated = 0;
    var bridgesAccepted = 0;
    var bridgeEdgeList = [];

    // Evaluate each endpoint pair
    for (var pi = 0; pi < endpoints.length; pi++) {
      var epA = endpoints[pi];
      var tokA = epA.token;
      var agx = (tokA.x / epCellSize) | 0;
      var agy = (tokA.y / epCellSize) | 0;

      for (var edy = -1; edy <= 1; edy++) {
        for (var edx = -1; edx <= 1; edx++) {
          var epNk = (agx + edx) + ',' + (agy + edy);
          var epCell = epGrid[epNk];
          if (!epCell) continue;
          for (var ej = 0; ej < epCell.length; ej++) {
            var epB = epCell[ej];
            if (epB.chainIdx <= epA.chainIdx) continue; // avoid duplicates, no self-bridges
            var tokB = epB.token;

            var gdx = tokB.x - tokA.x, gdy = tokB.y - tokA.y;
            var gap = Math.sqrt(gdx * gdx + gdy * gdy);
            if (gap < 2 || gap > maxGap) continue;

            bridgesEvaluated++;

            // ── Gate 1: Directional Agreement ──
            // The tangents at both endpoints should roughly align with
            // the vector connecting them (boundary continues through gap).
            var invGap = 1.0 / gap;
            var gapDirX = gdx * invGap, gapDirY = gdy * invGap;

            // For endpoint A, if it's the last token its tangent points
            // "outward" along the chain, so dot with gap direction should
            // be positive. If it's the first token, tangent points backward.
            var dotA = tokA.tangentX * gapDirX + tokA.tangentY * gapDirY;
            if (!epA.isFirst) dotA = -dotA; // last endpoint: tangent aims away from chain end
            // Actually: for the first token, tangent points from first->second,
            // which is INTO the chain, so for bridging outward we negate.
            dotA = epA.isFirst ? -dotA : dotA;

            var dotB = tokB.tangentX * gapDirX + tokB.tangentY * gapDirY;
            dotB = epB.isFirst ? dotB : -dotB;

            // Also check tangent-tangent alignment (both tangents roughly parallel)
            var tangentDot = Math.abs(tokA.tangentX * tokB.tangentX + tokA.tangentY * tokB.tangentY);

            // Use the weaker of endpoint-to-gap and tangent-tangent as the direction score
            var dirScore = Math.min(Math.max(dotA, 0), Math.max(dotB, 0));
            dirScore = Math.min(dirScore, tangentDot);
            if (dirScore < dirMin) continue;

            // ── Gate 2: Sided Color Consistency (with flip support) ──
            var llD = _labDist(tokA.leftLab, tokB.leftLab);
            var rrD = _labDist(tokA.rightLab, tokB.rightLab);
            var lrD = _labDist(tokA.leftLab, tokB.rightLab);
            var rlD = _labDist(tokA.rightLab, tokB.leftLab);
            var sameOK = llD <= bridgeSideTol && rrD <= bridgeSideTol;
            var flipOK = lrD <= bridgeSideTol && rlD <= bridgeSideTol;
            if (!sameOK && !flipOK) continue;

            // ── Gate 3: Corridor Evidence ──
            // Sample pixels between endpoints using edgeWeighted and gradMag.
            // Evidence score = mean of (edgeWeighted + normalized gradMag) along path.
            var steps = Math.max(Math.ceil(gap), 2);
            var evidenceSum = 0;
            for (var si = 0; si <= steps; si++) {
              var frac = si / steps;
              var sx = Math.round(tokA.x + gdx * frac);
              var sy = Math.round(tokA.y + gdy * frac);
              sx = sx < 0 ? 0 : sx >= W ? W - 1 : sx;
              sy = sy < 0 ? 0 : sy >= H ? H - 1 : sy;
              var sIdx = sy * W + sx;
              var eVal = edgeW[sIdx] / 255.0; // edgeWeighted is Uint8 0-255
              var gVal = gradMag[sIdx] * gradNorm;
              evidenceSum += (eVal * 0.6 + gVal * 0.4);
            }
            var evidenceScore = evidenceSum / (steps + 1);
            if (evidenceScore < minEvidence) continue;

            // ── Gate 4: Structural Weighting (NODEGROUP bonus) ──
            // Prioritize bridges that help close a perimeter or form convex shapes.
            // Heuristic: if connecting these chains would form a larger shape that
            // returns near its starting point, give a bonus.
            var combinedScore = evidenceScore + dirScore * 0.3;

            // Convexity / closure bonus: check if both chain endpoints
            // point roughly toward each other (attempting to close a shape).
            // The higher the dotA and dotB, the more "closing" this bridge is.
            var closureFactor = (Math.max(dotA, 0) + Math.max(dotB, 0)) * 0.5;
            if (closureFactor > 0.5) {
              combinedScore += structBonus;
            }

            // Prefer shorter gaps (less speculative)
            var gapPenalty = gap / maxGap * 0.1;
            combinedScore -= gapPenalty;

            if (combinedScore < minEvidence) continue;

            // ── Accept bridge ──
            bridgesAccepted++;
            adjacency[tokA.id].push(tokB.id);
            adjacency[tokB.id].push(tokA.id);
            bridgeEdgeList.push({
              from: tokA.id,
              to: tokB.id,
              fromX: tokA.x, fromY: tokA.y,
              toX: tokB.x, toY: tokB.y,
              gap: gap,
              dirScore: dirScore,
              evidenceScore: evidenceScore,
              combinedScore: combinedScore
            });
          }
        }
      }
    }

    return {
      bridgeEdgeList: bridgeEdgeList,
      bridgesEvaluated: bridgesEvaluated,
      bridgesAccepted: bridgesAccepted
    };
  }

  /**
   * Order a component's token IDs along the boundary curve.
   * Uses greedy walk from an endpoint (degree-1 node) or arbitrary start.
   */
  function _orderChain(compIds, adjacency, tokenById) {
    var inComp = {};
    for (var i = 0; i < compIds.length; i++) inComp[compIds[i]] = true;

    // Find endpoint (degree 1 within component) or use first
    var start = compIds[0];
    for (var j = 0; j < compIds.length; j++) {
      var deg = 0;
      var neis = adjacency[compIds[j]];
      for (var k = 0; k < neis.length; k++) {
        if (inComp[neis[k]]) deg++;
      }
      if (deg === 1) { start = compIds[j]; break; }
    }

    // Greedy walk: always pick the nearest unvisited neighbor
    var ordered = [start];
    var used = {};
    used[start] = true;

    while (ordered.length < compIds.length) {
      var last = ordered[ordered.length - 1];
      var lastTok = tokenById[last];
      var best = -1, bestDist = Infinity;
      var neis2 = adjacency[last];
      for (var n = 0; n < neis2.length; n++) {
        var nid = neis2[n];
        if (!inComp[nid] || used[nid]) continue;
        var nt = tokenById[nid];
        var d = (nt.x - lastTok.x) * (nt.x - lastTok.x) +
                (nt.y - lastTok.y) * (nt.y - lastTok.y);
        if (d < bestDist) { bestDist = d; best = nid; }
      }
      if (best < 0) break; // disconnected fragment
      ordered.push(best);
      used[best] = true;
    }

    return ordered;
  }

  /* ==================================================================
   *  Stage E: Region Partition
   * ================================================================== */

  function stageE_regionPartition(surface, evidence, boundaryGraph, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    var W = surface.width, H = surface.height, N = W * H;

    // ── 1. Build enhanced boundary map ──
    // Combine edgeBinary with boundary graph chain mask.
    // Tokens that survived into chains are stronger evidence than
    // isolated edge pixels, so boost them.
    var edgeBin = evidence.edgeBinary;
    var chainMask = boundaryGraph.chainMask;
    var boostW = cfg.boundaryBoostWeight;

    // Weighted edge: edge + chain boost → gradient for watershed
    var edgeStrength = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var e = edgeBin[i] > 0 ? 1.0 : 0.0;
      var c = chainMask[i] > 0 ? boostW : 0.0;
      edgeStrength[i] = Math.min(1.0, e + c);
    }

    // ── 2. Distance transform on inverted edge map ──
    var invEdge = new Uint8Array(N);
    for (var j = 0; j < N; j++) invEdge[j] = edgeStrength[j] > 0.5 ? 0 : 255;

    // Morphological open to clean noise
    invEdge = CV.morphOpen(invEdge, W, H, 1);

    var dist = CV.distanceTransform(invEdge, W, H);

    // ── 3. Find sure foreground (peaks of distance transform) ──
    var maxDist = 0;
    for (var d = 0; d < N; d++) if (dist[d] > maxDist) maxDist = dist[d];
    var fgThresh = maxDist * cfg.watershedFgFraction;
    if (fgThresh < 2) fgThresh = 2;

    var sureFg = new Uint8Array(N);
    for (var f = 0; f < N; f++) sureFg[f] = dist[f] > fgThresh ? 255 : 0;

    // ── 4. Markers from connected components of sure foreground ──
    var cc = CV.connectedComponents(sureFg, W, H);
    var markers = new Int32Array(N);
    for (var m = 0; m < N; m++) markers[m] = cc.labels[m]; // 0 = unknown, 1+ = seed

    // ── 5. Build gradient for watershed priority ──
    // Use edge strength + normalized gradient magnitude
    var gradMag = evidence.gradMag;
    var maxGrad = 0;
    for (var g = 0; g < N; g++) if (gradMag[g] > maxGrad) maxGrad = gradMag[g];
    var gradScale = maxGrad > 0 ? 128.0 / maxGrad : 0;

    var wsGradient = new Float32Array(N);
    for (var w = 0; w < N; w++) {
      wsGradient[w] = edgeStrength[w] * 127 + gradMag[w] * gradScale;
    }

    // ── 6. Watershed ──
    var wsLabels = CV.watershed(markers, wsGradient, W, H);

    // ── 7. Assign boundary pixels (-1) to nearest region ──
    var labels = new Int32Array(N);
    for (var b = 0; b < N; b++) {
      labels[b] = wsLabels[b] > 0 ? wsLabels[b] : 0;
    }
    // Iterative neighbor voting for unassigned pixels
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    var changed = true;
    var maxIter = 20;
    while (changed && maxIter-- > 0) {
      changed = false;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var idx = y * W + x;
          if (labels[idx] > 0) continue;
          // Find most common neighbor label
          var counts = {};
          for (var nd = 0; nd < 4; nd++) {
            var nx = x + dx4[nd], ny = y + dy4[nd];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            var nl = labels[ny * W + nx];
            if (nl > 0) counts[nl] = (counts[nl] || 0) + 1;
          }
          var best = 0, bestC = 0;
          for (var k in counts) {
            if (counts[k] > bestC) { bestC = counts[k]; best = +k; }
          }
          if (best > 0) { labels[idx] = best; changed = true; }
        }
      }
    }

    // ── 8. Merge tiny regions ──
    var regionAreas = {};
    for (var ra = 0; ra < N; ra++) {
      var rl = labels[ra];
      regionAreas[rl] = (regionAreas[rl] || 0) + 1;
    }
    var minArea = cfg.minRegionArea;
    for (var rl2 in regionAreas) {
      if (+rl2 <= 0 || regionAreas[rl2] >= minArea) continue;
      // Find majority neighbor for this tiny region
      var nCounts = {};
      for (var my = 0; my < H; my++) {
        for (var mx = 0; mx < W; mx++) {
          if (labels[my * W + mx] !== +rl2) continue;
          for (var md = 0; md < 4; md++) {
            var mnx = mx + dx4[md], mny = my + dy4[md];
            if (mnx < 0 || mnx >= W || mny < 0 || mny >= H) continue;
            var mnl = labels[mny * W + mnx];
            if (mnl > 0 && mnl !== +rl2) nCounts[mnl] = (nCounts[mnl] || 0) + 1;
          }
        }
      }
      var target = 0, targetC = 0;
      for (var nk in nCounts) {
        if (nCounts[nk] > targetC) { targetC = nCounts[nk]; target = +nk; }
      }
      if (target > 0) {
        for (var mr = 0; mr < N; mr++) {
          if (labels[mr] === +rl2) labels[mr] = target;
        }
      }
    }

    // ── 9. Relabel sequentially ──
    var uniq = {};
    for (var sq = 0; sq < N; sq++) uniq[labels[sq]] = true;
    var sortedLabels = Object.keys(uniq).map(Number).sort(function(a,b){ return a-b; });
    var remap = {};
    var nextId = 1;
    for (var si = 0; si < sortedLabels.length; si++) {
      if (sortedLabels[si] <= 0) { remap[sortedLabels[si]] = 0; continue; }
      remap[sortedLabels[si]] = nextId++;
    }
    var regionCount = nextId - 1;
    for (var rl3 = 0; rl3 < N; rl3++) labels[rl3] = remap[labels[rl3]] || 1;

    // ── 10. Compute region stats and adjacency ──
    var stats = {};
    var adj = {};
    for (var ri = 1; ri <= regionCount; ri++) {
      stats[ri] = { area: 0, minX: W, minY: H, maxX: 0, maxY: 0, sumX: 0, sumY: 0 };
      adj[ri] = {};
    }

    for (var sy = 0; sy < H; sy++) {
      for (var sx = 0; sx < W; sx++) {
        var sl = labels[sy * W + sx];
        if (sl <= 0) continue;
        var st = stats[sl];
        st.area++;
        st.sumX += sx; st.sumY += sy;
        if (sx < st.minX) st.minX = sx;
        if (sx > st.maxX) st.maxX = sx;
        if (sy < st.minY) st.minY = sy;
        if (sy > st.maxY) st.maxY = sy;

        // Check right and down for adjacency
        if (sx + 1 < W) {
          var rn = labels[sy * W + sx + 1];
          if (rn > 0 && rn !== sl) { adj[sl][rn] = true; adj[rn][sl] = true; }
        }
        if (sy + 1 < H) {
          var dn = labels[(sy + 1) * W + sx];
          if (dn > 0 && dn !== sl) { adj[sl][dn] = true; adj[dn][sl] = true; }
        }
      }
    }

    var finalStats = {};
    for (var fs = 1; fs <= regionCount; fs++) {
      var s = stats[fs];
      if (s.area === 0) continue;
      finalStats[fs] = {
        area: s.area,
        bboxX: s.minX, bboxY: s.minY,
        bboxW: s.maxX - s.minX + 1, bboxH: s.maxY - s.minY + 1,
        cx: s.sumX / s.area, cy: s.sumY / s.area
      };
    }
    var finalAdj = {};
    for (var fa in adj) finalAdj[fa] = Object.keys(adj[fa]).map(Number);

    // ── 11. Compute boundary pixel mask ──
    var boundaries = new Uint8Array(N);
    for (var by2 = 0; by2 < H; by2++) {
      for (var bx = 0; bx < W; bx++) {
        var bl = labels[by2 * W + bx];
        for (var bd = 0; bd < 4; bd++) {
          var bnx = bx + dx4[bd], bny = by2 + dy4[bd];
          if (bnx < 0 || bnx >= W || bny < 0 || bny >= H) continue;
          if (labels[bny * W + bnx] !== bl) { boundaries[by2 * W + bx] = 255; break; }
        }
      }
    }

    return {
      kind: 'wfg3-region-partition',
      width: W, height: H,
      labelMap: labels,
      regionCount: regionCount,
      stats: finalStats,
      adjacency: finalAdj,
      boundaries: boundaries
    };
  }

  /* ==================================================================
   *  Stage F: Region Grouping
   * ================================================================== */

  function stageF_regionGrouping(partition, surface, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    var W = partition.width, H = partition.height, N = W * H;
    var labels = partition.labelMap;
    var adj = partition.adjacency;
    var stats = partition.stats;
    var regionCount = partition.regionCount;
    var threshold = cfg.groupMergeThreshold;
    var minPerimRatio = cfg.groupMinPerimeterRatio;

    // ── Compute mean LAB per region ──
    var hasLab = !!(surface.lab);
    var regionLab = {};
    if (hasLab) {
      var L = surface.lab.L, la = surface.lab.a, lb = surface.lab.b;
      var sums = {};
      for (var ri = 1; ri <= regionCount; ri++) sums[ri] = { L: 0, a: 0, b: 0, n: 0 };
      for (var pi = 0; pi < N; pi++) {
        var rl = labels[pi];
        if (rl > 0 && sums[rl]) { sums[rl].L += L[pi]; sums[rl].a += la[pi]; sums[rl].b += lb[pi]; sums[rl].n++; }
      }
      for (var ri2 = 1; ri2 <= regionCount; ri2++) {
        var s = sums[ri2];
        if (s.n > 0) regionLab[ri2] = { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
        else regionLab[ri2] = { L: 50, a: 0, b: 0 };
      }
    }

    // ── Compute shared boundary lengths between adjacent regions ──
    var sharedLen = {};
    for (var sy = 0; sy < H; sy++) {
      for (var sx = 0; sx < W; sx++) {
        var sl = labels[sy * W + sx];
        if (sl <= 0) continue;
        // Right neighbor
        if (sx + 1 < W) {
          var rn = labels[sy * W + sx + 1];
          if (rn > 0 && rn !== sl) {
            var pk = Math.min(sl, rn) + ',' + Math.max(sl, rn);
            sharedLen[pk] = (sharedLen[pk] || 0) + 1;
          }
        }
        // Down neighbor
        if (sy + 1 < H) {
          var dn = labels[(sy + 1) * W + sx];
          if (dn > 0 && dn !== sl) {
            var pk2 = Math.min(sl, dn) + ',' + Math.max(sl, dn);
            sharedLen[pk2] = (sharedLen[pk2] || 0) + 1;
          }
        }
      }
    }

    // ── Compute perimeter per region ──
    var perimeter = {};
    for (var pr = 1; pr <= regionCount; pr++) perimeter[pr] = 0;
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    for (var py = 0; py < H; py++) {
      for (var px = 0; px < W; px++) {
        var pl = labels[py * W + px];
        if (pl <= 0) continue;
        for (var pd = 0; pd < 4; pd++) {
          var pnx = px + dx4[pd], pny = py + dy4[pd];
          if (pnx < 0 || pnx >= W || pny < 0 || pny >= H || labels[pny * W + pnx] !== pl) {
            perimeter[pl]++;
          }
        }
      }
    }

    // ── Score adjacent pairs for merge ──
    var mergeScores = [];
    for (var pk3 in sharedLen) {
      var parts = pk3.split(',');
      var a = +parts[0], b = +parts[1];
      var sLen = sharedLen[pk3];
      var perimA = perimeter[a] || 1;
      var perimB = perimeter[b] || 1;
      var minPerim = Math.min(perimA, perimB);

      // Signal 1: shared boundary ratio (how much of the smaller region's
      // perimeter is shared with the other)
      var boundaryRatio = sLen / minPerim;
      if (boundaryRatio < minPerimRatio) continue; // too little contact

      // Signal 2: color similarity (LAB delta between region means)
      var colorSim = 0;
      if (hasLab && regionLab[a] && regionLab[b]) {
        var dL = regionLab[a].L - regionLab[b].L;
        var da = regionLab[a].a - regionLab[b].a;
        var db = regionLab[a].b - regionLab[b].b;
        var de = Math.sqrt(dL * dL + da * da + db * db);
        colorSim = Math.max(0, 1 - de / 60); // 0 at ΔE=60, 1 at ΔE=0
      } else {
        colorSim = 0.5; // no color info, neutral
      }

      // Signal 3: area ratio bonus (small fragments get a merge boost)
      var areaA = stats[a] ? stats[a].area : 1;
      var areaB = stats[b] ? stats[b].area : 1;
      var areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
      var fragmentBonus = areaRatio < 0.1 ? 0.2 : 0;

      var score = boundaryRatio * 0.40 + colorSim * 0.45 + fragmentBonus + 0.15 * areaRatio;
      mergeScores.push({ a: a, b: b, score: score, boundaryRatio: boundaryRatio, colorSim: colorSim });
    }

    // ── Union-Find merge above threshold ──
    var parent = {};
    for (var uf = 1; uf <= regionCount; uf++) parent[uf] = uf;
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(x, y) {
      x = find(x); y = find(y);
      if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    }

    // Sort by score descending and merge greedily
    mergeScores.sort(function(a, b) { return b.score - a.score; });
    for (var ms = 0; ms < mergeScores.length; ms++) {
      if (mergeScores[ms].score < threshold) break;
      union(mergeScores[ms].a, mergeScores[ms].b);
    }

    // ── Build group labels ──
    var groupRemap = {};
    var nextGroup = 1;
    var groupLabelMap = new Int32Array(N);
    for (var gl = 0; gl < N; gl++) {
      var rl4 = labels[gl];
      if (rl4 <= 0) { groupLabelMap[gl] = 0; continue; }
      var root = find(rl4);
      if (!groupRemap[root]) groupRemap[root] = nextGroup++;
      groupLabelMap[gl] = groupRemap[root];
    }
    var groupCount = nextGroup - 1;

    // ── Group stats ──
    var groups = {};
    var groupRegions = {};
    for (var gr = 1; gr <= regionCount; gr++) {
      var gRoot = find(gr);
      var gId = groupRemap[gRoot];
      if (!gId) continue;
      if (!groupRegions[gId]) groupRegions[gId] = [];
      groupRegions[gId].push(gr);
    }

    for (var gid in groupRegions) {
      var rids = groupRegions[gid];
      var totalArea = 0, sumX = 0, sumY = 0;
      var gMinX = W, gMinY = H, gMaxX = 0, gMaxY = 0;
      for (var gri = 0; gri < rids.length; gri++) {
        var rs = stats[rids[gri]];
        if (!rs) continue;
        totalArea += rs.area;
        sumX += rs.cx * rs.area;
        sumY += rs.cy * rs.area;
        if (rs.bboxX < gMinX) gMinX = rs.bboxX;
        if (rs.bboxY < gMinY) gMinY = rs.bboxY;
        if (rs.bboxX + rs.bboxW > gMaxX) gMaxX = rs.bboxX + rs.bboxW;
        if (rs.bboxY + rs.bboxH > gMaxY) gMaxY = rs.bboxY + rs.bboxH;
      }
      groups[gid] = {
        regionIds: rids,
        area: totalArea,
        cx: totalArea > 0 ? sumX / totalArea : 0,
        cy: totalArea > 0 ? sumY / totalArea : 0,
        bboxX: gMinX, bboxY: gMinY,
        bboxW: gMaxX - gMinX, bboxH: gMaxY - gMinY
      };
    }

    // ── Group boundaries ──
    var groupBounds = new Uint8Array(N);
    for (var gby = 0; gby < H; gby++) {
      for (var gbx = 0; gbx < W; gbx++) {
        var gbl = groupLabelMap[gby * W + gbx];
        for (var gbd = 0; gbd < 4; gbd++) {
          var gnx = gbx + dx4[gbd], gny = gby + dy4[gbd];
          if (gnx < 0 || gnx >= W || gny < 0 || gny >= H) continue;
          if (groupLabelMap[gny * W + gnx] !== gbl) { groupBounds[gby * W + gbx] = 255; break; }
        }
      }
    }

    return {
      kind: 'wfg3-group-map',
      width: W, height: H,
      labelMap: groupLabelMap,
      groupCount: groupCount,
      groups: groups,
      boundaries: groupBounds,
      _mergeScores: mergeScores // exposed for debug
    };
  }

  /* ── Extend public API ── */

  Stages.DEFAULT_CONFIG_DF = DEFAULT_CONFIG_DF;
  Stages.stageD = stageD_boundaryGraph;
  Stages.stageE = stageE_regionPartition;
  Stages.stageF = stageF_regionGrouping;

})(typeof window !== 'undefined' ? window : globalThis);
