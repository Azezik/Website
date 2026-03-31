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
    graphNeighborRadius:     9,
    graphForwardRadius:      16,
    graphForwardDirMin:      0.70,
    graphForwardLateralMax:  4,
    graphOrientationTolDeg: 45,
    graphSideDeltaETol:    25,
    chainMinLength:        2,
    linkScoreThreshold:    0.32,
    chainExtensionMaxDist: 40,
    chainExtensionDirAlign: 0.50,
    chainExtensionColorTol: 120,
    chainExtensionTrendWindow: 4,
    chainExtensionMaxDirDrift: 0.40,

    // Microchaining: use local strict-link populations to reinforce continuation
    microchainEnabled:          true,
    microchainMinCandidates:    3,    // min candidates to activate microchain logic
    microchainCoherenceThresh:  0.50, // min dot product for candidates to be "coherent"
    microchainDriftRelief:      0.50, // how much microchain support can soften drift gate (0..1)
    microchainSupportDecay:     0.85, // per-step decay of accumulated support (momentum)
    microchainSupportFloor:     0.15, // accumulated support below this = no relief

    // Lookahead: short-horizon continuation probe (2-4 steps ahead)
    lookaheadEnabled:           true,
    lookaheadMaxDepth:          4,    // max probe steps beyond candidate
    lookaheadScoreWeight:       0.25, // weight of lookahead score in candidate ranking
    lookaheadDriftRescueDepth:  2,    // min future steps to rescue a borderline drift step
    lookaheadCoherenceFraction: 0.30, // fraction of lookahead weight devoted to direction
                                      // coherence (stable curvature / clean segment preference)

    // Stage D: Pass-2 Bridging (token-native, geometry-first)
    bridgeEnabled:          true,
    bridgeMaxGapPx:         18,
    bridgeDirAgreementMin:  0.50,
    bridgeSideDeltaETol:    30,
    bridgeMinCombinedScore: 0.30,

    // Stage D: Structural outlier pruning
    outlierPruneEnabled:    true,
    outlierDirDeviationMax: 0.35,
    outlierMinNeighborSupport: 2,
    outlierPruneTinyComponents: true,
    outlierTinyComponentSize: 1,

    // Stage D: Multi-token XY trend reasoning
    // When recent chain tokens clearly form a coherent linear/curved arrangement
    // in XY space, blend that PCA-derived direction into the extension direction.
    // This makes extension less brittle when individual token tangents are noisy.
    xyTrendEnabled:          true,
    xyTrendWindowSize:       10,   // tokens used for XY trend PCA fit
    xyTrendMinTokens:        4,    // minimum chain tokens needed to activate
    xyTrendBlendWeight:      0.30, // max blend weight of XY trend (0 = off, 1 = full)
    xyTrendConsistencyMin:   0.65, // min R²-like fit quality to use trend at all

    // Stage D: Lookahead upgrade
    // Depth increase + beam search + density bonus
    lookaheadBeamWidth:      2,    // how many candidates to try at each probe step
    lookaheadDensityRadius:  12,   // radius (px) for structural density count bonus
    lookaheadDensityWeight:  0.10, // max score bonus from nearby structural density

    // Stage D: Closure pass
    // After extension, detect chains whose endpoints are geometrically close
    // and link them when the geometry (endpoint trends) supports it.
    closureEnabled:          true,
    closureMinChainLen:      6,    // minimum chain token count to attempt closure
    closureMaxGapPx:         24,   // maximum gap allowed for closure connection
    closureTrendMin:         0.40, // minimum trend agreement for closure acceptance
    closureColorTol:         35,   // side-color tolerance for closure acceptance

    // Stage D: Branch anchor recovery
    // When _recoverResidualChains finds tokens not covered by the primary ordering,
    // include the primary-chain junction token as an anchor so that T-junction arms
    // are rooted at the real branch point rather than appearing as floating fragments.
    branchAnchorEnabled:     true,

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

  function stageD_boundaryGraph(tokens, cfg) {
    cfg = cfg || DEFAULT_CONFIG_DF;
    // Derive image dimensions from token positions (needed only for chain mask rasterization)
    var W = cfg.imageWidth || 0, H = cfg.imageHeight || 0;
    for (var di = 0; di < tokens.length; di++) {
      if (tokens[di].x >= W) W = tokens[di].x + 1;
      if (tokens[di].y >= H) H = tokens[di].y + 1;
    }
    var radius = cfg.graphNeighborRadius;
    var fwdRadius = cfg.graphForwardRadius || 16;
    var fwdDirMin = cfg.graphForwardDirMin || 0.70;
    var fwdLatMax = cfg.graphForwardLateralMax || 4;
    var sideTol = cfg.graphSideDeltaETol;
    var linkThreshold = cfg.linkScoreThreshold != null ? cfg.linkScoreThreshold : 0.45;

    // Spatial index: cell size set so a ±1 cell scan (3x3) covers fwdRadius.
    // A token at position p in cell C can reach any token in cells C ± 1.
    // Worst case: token at cell boundary (0) → farthest point in neighbor cell
    // is cellSize * 2. So cellSize must be >= fwdRadius to guarantee coverage.
    var cellSize = fwdRadius + 1;
    var grid = {};
    for (var ti = 0; ti < tokens.length; ti++) {
      var t = tokens[ti];
      var gx = (t.x / cellSize) | 0;
      var gy = (t.y / cellSize) | 0;
      var key = gx + ',' + gy;
      if (!grid[key]) grid[key] = [];
      grid[key].push(t);
    }

    // Build adjacency (Pass 1: geometry-first with directional forward reach)
    //
    // Two acceptance zones per token pair:
    //   Zone 1 (base):    dist <= radius — standard omnidirectional check
    //   Zone 2 (forward): dist <= fwdRadius — requires strong tangent alignment
    //                      and small lateral offset (elliptical reach along tangent)
    //
    // This lets tokens 8-16px apart along a boundary connect when
    // geometrically consistent, without linking across parallel edges.
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
            var dist2 = ddx * ddx + ddy * ddy;

            // Quick reject: beyond even the extended forward radius
            if (dist2 > fwdRadius * fwdRadius) continue;

            var dist = Math.sqrt(dist2);
            var inBaseRadius = dist <= radius;

            // Direction score: |dot(tangentA, tangentB)|
            var dot = a.tangentX * b.tangentX + a.tangentY * b.tangentY;
            var dirScore = Math.abs(dot);

            // Hard floor: reject truly perpendicular tangents (>80°)
            if (dirScore < 0.17) continue; // cos(80°) ≈ 0.17

            if (!inBaseRadius) {
              // ── Zone 2: directionally-biased forward reach ──
              // Only accept if both tangents are well-aligned and the
              // connection vector runs along the tangent direction (not across).
              if (dirScore < fwdDirMin) continue;

              // Decompose the connection vector into along-tangent and
              // across-tangent components using the average tangent direction.
              // Use the average of both tangents (sign-aligned) as the axis.
              var avgTx, avgTy;
              if (dot >= 0) {
                avgTx = a.tangentX + b.tangentX;
                avgTy = a.tangentY + b.tangentY;
              } else {
                avgTx = a.tangentX - b.tangentX;
                avgTy = a.tangentY - b.tangentY;
              }
              var avgMag = Math.sqrt(avgTx * avgTx + avgTy * avgTy);
              if (avgMag < 0.01) continue;
              avgTx /= avgMag; avgTy /= avgMag;

              // Project connection vector onto the average tangent
              var alongDist = Math.abs(ddx * avgTx + ddy * avgTy);
              var lateralDist = Math.abs(ddx * (-avgTy) + ddy * avgTx);

              // Reject if lateral offset is too large (prevents cross-edge links)
              if (lateralDist > fwdLatMax) continue;

              // Also check that the connection vector aligns with tangents.
              // This catches cases where tangents are parallel but the token
              // pair is side-by-side rather than along the boundary.
              var connMag = dist; // already computed
              var connDotA = Math.abs(a.tangentX * ddx + a.tangentY * ddy) / connMag;
              var connDotB = Math.abs(b.tangentX * ddx + b.tangentY * ddy) / connMag;
              var connAlign = Math.min(connDotA, connDotB);
              if (connAlign < 0.50) continue;
            }

            // ── Scoring ──
            // Use the effective radius for distance normalization:
            // base radius for Zone 1, forward radius for Zone 2.
            var effectiveRadius = inBaseRadius ? radius : fwdRadius;
            var distRatio = dist / effectiveRadius;
            var distScore = 1.0 - distRatio * distRatio;

            // Side color score: weak tiebreaker only.
            var llDist = _labDist(a.leftLab, b.leftLab);
            var rrDist = _labDist(a.rightLab, b.rightLab);
            var lrDist = _labDist(a.leftLab, b.rightLab);
            var rlDist = _labDist(a.rightLab, b.leftLab);
            var sameDist = (llDist + rrDist) * 0.5;
            var flipDist = (lrDist + rlDist) * 0.5;
            var bestColorDist = Math.min(sameDist, flipDist);
            var colorScore = Math.max(0, 1.0 - bestColorDist / (sideTol * 2));

            // Geometry-dominant weighting: direction 50%, distance 40%, color 10%
            var linkScore = 0.50 * dirScore + 0.40 * distScore + 0.10 * colorScore;

            if (linkScore < linkThreshold) continue;

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

      // Recover residual tokens that _orderChain dropped from this component.
      // These are valid graph structure that would otherwise be silently lost.
      var residuals = _recoverResidualChains(comp2, ordered, adjacency, tokenById, cfg.chainMinLength, cfg.branchAnchorEnabled);
      for (var rsi = 0; rsi < residuals.length; rsi++) {
        var resOrdered = residuals[rsi];
        chains.push({ ids: resOrdered, ordered: true });
        var resLoop = _isLoopChain(resOrdered, adjacency, comp2);
        if (resLoop) loops.push({ ids: resOrdered });
      }
    }

    /* ================================================================
     *  Pass 1b: Chain Endpoint Continuation (token-native)
     *  Extend chains by finding compatible unlinked tokens along the
     *  chain's directional trend. No image evidence is consulted.
     * ================================================================ */

    _extendChainEndpoints(chains, adjacency, tokenById, cfg);

    /* ================================================================
     *  Pass 2: Bridge Candidates
     *  Scan chain endpoints for pairings across larger gaps.
     * ================================================================ */

    var bridgeEdgeList = [];
    var bridgesEvaluated = 0;
    var bridgesAccepted = 0;

    if (cfg.bridgeEnabled && chains.length > 1) {
      var bridgeResult = _bridgePass(
        chains, loops, adjacency, tokenById, cfg
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

          // Recover residual tokens after bridge re-ordering
          var bridgeResiduals = _recoverResidualChains(comp4, ordered2, adjacency, tokenById, cfg.chainMinLength, cfg.branchAnchorEnabled);
          for (var bri = 0; bri < bridgeResiduals.length; bri++) {
            var brOrdered = bridgeResiduals[bri];
            chains.push({ ids: brOrdered, ordered: true });
            var brLoop = _isLoopChain(brOrdered, adjacency, comp4);
            if (brLoop) loops.push({ ids: brOrdered });
          }
        }
      }
    }

    /* ================================================================
     *  Pass 2b: Closure Pass
     *  Detect chain endpoints that are geometrically close and
     *  trend-compatible, then link them (self-closure or cross-chain
     *  rejoin). Runs after extension and bridging so it operates on
     *  the most complete chain state available.
     * ================================================================ */

    if (cfg.closureEnabled !== false) {
      var closureResult = _closurePass(chains, loops, adjacency, tokenById, cfg);
      if (closureResult.closureCount > 0) {
        // Rebuild components and chains after closure links are added
        components = _componentsFromAdjacency(tokens, adjacency, cfg.chainMinLength);
        chains = [];
        loops = [];
        for (var cci = 0; cci < components.length; cci++) {
          var ccomp = components[cci];
          var ccOrdered = _orderChain(ccomp, adjacency, tokenById);
          var ccLoop = _isLoopChain(ccOrdered, adjacency, ccomp);
          chains.push({ ids: ccOrdered, ordered: true });
          if (ccLoop) loops.push({ ids: ccOrdered });
          var ccResiduals = _recoverResidualChains(
            ccomp, ccOrdered, adjacency, tokenById,
            cfg.chainMinLength, cfg.branchAnchorEnabled
          );
          for (var ccri = 0; ccri < ccResiduals.length; ccri++) {
            var ccResOrdered = ccResiduals[ccri];
            chains.push({ ids: ccResOrdered, ordered: true });
            if (_isLoopChain(ccResOrdered, adjacency, ccomp)) {
              loops.push({ ids: ccResOrdered });
            }
          }
        }
      }
    }

    // Structural outlier pruning: remove tokens that mismatch their
    // neighbors structurally (direction, color), regardless of confidence.
    if (cfg.outlierPruneEnabled !== false) {
      var cleanup = _pruneStructuralOutliers(tokens, adjacency, tokenById, cfg);
      if (cleanup.prunedCount > 0) {
        components = _componentsFromAdjacency(tokens, adjacency, cfg.chainMinLength);
        chains = [];
        loops = [];
        for (var ck = 0; ck < components.length; ck++) {
          var compX = components[ck];
          var orderedX = _orderChain(compX, adjacency, tokenById);
          var loopX = _isLoopChain(orderedX, adjacency, compX);
          chains.push({ ids: orderedX, ordered: true });
          if (loopX) loops.push({ ids: orderedX });

          // Recover residual tokens after post-prune re-ordering
          var pruneResiduals = _recoverResidualChains(compX, orderedX, adjacency, tokenById, cfg.chainMinLength, cfg.branchAnchorEnabled);
          for (var pri = 0; pri < pruneResiduals.length; pri++) {
            var prOrdered = pruneResiduals[pri];
            chains.push({ ids: prOrdered, ordered: true });
            var prLoop = _isLoopChain(prOrdered, adjacency, compX);
            if (prLoop) loops.push({ ids: prOrdered });
          }
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

  function _componentsFromAdjacency(tokens, adjacency, minLen) {
    var visited = {};
    var components = [];
    for (var vi = 0; vi < tokens.length; vi++) {
      var tid = tokens[vi].id;
      if (visited[tid] || !adjacency[tid]) continue;
      var comp = [];
      var queue = [tid];
      visited[tid] = true;
      while (queue.length > 0) {
        var cur = queue.shift();
        comp.push(cur);
        var neis = adjacency[cur] || [];
        for (var ni = 0; ni < neis.length; ni++) {
          var nid = neis[ni];
          if (!visited[nid]) {
            visited[nid] = true;
            queue.push(nid);
          }
        }
      }
      if (comp.length >= minLen) components.push(comp);
    }
    return components;
  }

  function _isLoopChain(ordered, adjacency, componentIds) {
    if (!ordered || ordered.length < 6) return false;
    var first = ordered[0], last = ordered[ordered.length - 1];
    if (!adjacency[first] || adjacency[first].indexOf(last) < 0) return false;
    for (var i = 0; i < ordered.length; i++) {
      var deg = 0;
      var neis = adjacency[ordered[i]] || [];
      for (var j = 0; j < neis.length; j++) {
        if (componentIds.indexOf(neis[j]) >= 0) deg++;
      }
      if (deg < 2) return false;
    }
    return true;
  }

  /**
   * Structural outlier pruning (token-native).
   *
   * Two-pass approach:
   *   Pass A — Adjacency-based: tokens with few neighbors that also
   *            mismatch structurally (direction or color) are removed.
   *   Pass B — Chain-internal: within each ordered chain, tokens that
   *            create spatial zigzags or tangent breaks relative to their
   *            local chain neighborhood are removed.
   *
   * Confidence is NOT used as a gate. Only structural fit matters.
   */
  function _pruneStructuralOutliers(tokens, adjacency, tokenById, cfg) {
    var dirDevMax = cfg.outlierDirDeviationMax != null ? cfg.outlierDirDeviationMax : 0.35;
    var minSupport = Math.max(1, cfg.outlierMinNeighborSupport || 2);
    var pruneTiny = cfg.outlierPruneTinyComponents !== false;
    var tinyMax = Math.max(0, cfg.outlierTinyComponentSize || 1);
    var removed = {};
    var prunedCount = 0;

    // ── Pass A: adjacency-based structural mismatch ──
    // Degree-1 tokens are often valid chain endpoints (especially after
    // residual recovery). Use a more lenient threshold for them so that
    // endpoints with reasonable alignment survive. Only tokens that are
    // truly misaligned get pruned.
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var neis = adjacency[t.id] || [];
      if (neis.length >= minSupport) continue;

      if (neis.length === 0) {
        removed[t.id] = true;
        continue;
      }

      var fit = _tokenNeighborFit(t, neis, tokenById);
      // Degree-1 tokens get 50% more lenient threshold — they are often
      // valid chain endpoints, not outliers
      var effectiveDevMax = neis.length === 1 ? dirDevMax * 1.5 : dirDevMax;
      if (fit.dirDev > effectiveDevMax) {
        removed[t.id] = true;
      }
    }

    // ── Pass B: chain-internal trend outlier detection ──
    // Walk each ordered chain and flag tokens that create spatial
    // zigzags — where the direction to the token deviates sharply
    // from the smooth trend formed by its chain neighbors.
    var compsForScan = _componentsFromAdjacency(tokens, adjacency, 3);
    for (var sci = 0; sci < compsForScan.length; sci++) {
      var scanComp = compsForScan[sci];
      var scanOrdered = _orderChain(scanComp, adjacency, tokenById);
      if (scanOrdered.length < 4) continue;

      for (var sj = 1; sj < scanOrdered.length - 1; sj++) {
        var prevTok = tokenById[scanOrdered[sj - 1]];
        var curTok  = tokenById[scanOrdered[sj]];
        var nextTok = tokenById[scanOrdered[sj + 1]];
        if (!prevTok || !curTok || !nextTok) continue;
        if (removed[curTok.id]) continue;

        // Direction from prev→cur and cur→next
        var d1x = curTok.x - prevTok.x, d1y = curTok.y - prevTok.y;
        var d2x = nextTok.x - curTok.x, d2y = nextTok.y - curTok.y;
        var m1 = Math.sqrt(d1x * d1x + d1y * d1y);
        var m2 = Math.sqrt(d2x * d2x + d2y * d2y);
        if (m1 < 0.5 || m2 < 0.5) continue;

        // Spatial zigzag: the angle between consecutive segments.
        // On a smooth boundary, consecutive segments are roughly collinear.
        // A sharp reversal (negative dot) indicates a zigzag.
        var segDot = (d1x * d2x + d1y * d2y) / (m1 * m2);
        if (segDot < -0.3) {
          // Sharp spatial reversal — this token is a zigzag outlier.
          // But only prune if it also fails tangent consistency.
          var fitC = _tokenNeighborFit(curTok, adjacency[curTok.id] || [], tokenById);
          if (fitC.dirDev > dirDevMax * 0.8) {
            removed[curTok.id] = true;
          }
        }

        // Also check: token tangent deviates from the local chain trend
        // (prev→next direction), which catches off-trend tokens that happen
        // to be spatially in-line but oriented wrong.
        var trendX = nextTok.x - prevTok.x, trendY = nextTok.y - prevTok.y;
        var trendMag = Math.sqrt(trendX * trendX + trendY * trendY);
        if (trendMag > 0.5) {
          var trendDot = Math.abs(curTok.tangentX * trendX + curTok.tangentY * trendY) / trendMag;
          // trendDot < 0.3 means tangent is nearly perpendicular to local flow
          if (trendDot < 0.25) {
            removed[curTok.id] = true;
          }
        }
      }
    }

    // ── Prune tiny components where all members lack structural support ──
    if (pruneTiny) {
      var comps = _componentsFromAdjacency(tokens, adjacency, 1);
      for (var ci = 0; ci < comps.length; ci++) {
        var comp = comps[ci];
        if (comp.length > tinyMax) continue;
        var allWeak = true;
        for (var cj = 0; cj < comp.length; cj++) {
          var neiCount = (adjacency[comp[cj]] || []).length;
          if (neiCount >= minSupport) { allWeak = false; break; }
        }
        if (allWeak) {
          for (var cr = 0; cr < comp.length; cr++) removed[comp[cr]] = true;
        }
      }
    }

    // ── Remove flagged tokens from adjacency ──
    for (var rid in removed) {
      var id = +rid;
      if (!adjacency[id]) continue;
      var nbrs = adjacency[id];
      for (var n = 0; n < nbrs.length; n++) {
        var nid = nbrs[n];
        var list = adjacency[nid];
        if (!list) continue;
        var nextList = [];
        for (var li = 0; li < list.length; li++) if (list[li] !== id) nextList.push(list[li]);
        adjacency[nid] = nextList;
      }
      adjacency[id] = [];
      prunedCount++;
    }

    return { prunedCount: prunedCount };
  }

  /**
   * Compute structural fit of a token relative to its neighbors.
   * Returns { dirDev: 0..1, colorDev: ΔE }.
   */
  function _tokenNeighborFit(tok, neis, tokenById) {
    var avgTx = 0, avgTy = 0, avgColorDist = 0, nCount = 0;
    for (var ni = 0; ni < neis.length; ni++) {
      var nb = tokenById[neis[ni]];
      if (!nb) continue;
      var dot = tok.tangentX * nb.tangentX + tok.tangentY * nb.tangentY;
      if (dot >= 0) { avgTx += nb.tangentX; avgTy += nb.tangentY; }
      else { avgTx -= nb.tangentX; avgTy -= nb.tangentY; }
      var llD = _labDist(tok.leftLab, nb.leftLab);
      var rrD = _labDist(tok.rightLab, nb.rightLab);
      var lrD = _labDist(tok.leftLab, nb.rightLab);
      var rlD = _labDist(tok.rightLab, nb.leftLab);
      avgColorDist += Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
      nCount++;
    }
    if (nCount === 0) return { dirDev: 1.0, colorDev: 999 };
    avgTx /= nCount; avgTy /= nCount; avgColorDist /= nCount;
    var avgMag = Math.sqrt(avgTx * avgTx + avgTy * avgTy);
    var dirDev = 1.0;
    if (avgMag > 0.01) {
      dirDev = 1.0 - Math.abs((tok.tangentX * avgTx + tok.tangentY * avgTy) / avgMag);
    }
    return { dirDev: dirDev, colorDev: avgColorDist };
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
   *  Pass 2: Token-native bridge evaluation
   *  Bridges are justified purely from token-to-token continuity:
   *    - directional compatibility (tangent alignment + gap alignment)
   *    - sided color consistency
   *    - gap distance plausibility
   *    - curve continuity (chain-end trend vs gap direction)
   *  No image evidence maps are consulted.
   * ================================================================ */

  function _bridgePass(chains, loops, adjacency, tokenById, cfg) {
    var maxGap = cfg.bridgeMaxGapPx;
    var dirMin = cfg.bridgeDirAgreementMin;
    var bridgeSideTol = cfg.bridgeSideDeltaETol;
    var minCombined = cfg.bridgeMinCombinedScore != null ? cfg.bridgeMinCombinedScore : 0.30;

    // Identify chain endpoints (first/last token in each non-loop chain)
    var loopSet = {};
    for (var lsi = 0; lsi < loops.length; lsi++) {
      var loopIds = loops[lsi].ids;
      for (var lsj = 0; lsj < loopIds.length; lsj++) loopSet[loopIds[lsj]] = true;
    }

    // For each endpoint, also compute the chain-end trend direction
    // from the last few tokens, for curve-aware bridging.
    var endpoints = []; // { token, chainIdx, isFirst, trendX, trendY }
    for (var ei = 0; ei < chains.length; ei++) {
      var ch = chains[ei].ids;
      if (ch.length < 2) continue;
      var firstId = ch[0], lastId = ch[ch.length - 1];
      if (loopSet[firstId] && loopSet[lastId]) continue;

      var firstTok = tokenById[firstId];
      var lastTok = tokenById[lastId];

      if (firstTok) {
        var ft = _chainEndTrend(ch, true, tokenById);
        endpoints.push({ token: firstTok, chainIdx: ei, isFirst: true, trendX: ft[0], trendY: ft[1] });
      }
      if (lastTok) {
        var lt = _chainEndTrend(ch, false, tokenById);
        endpoints.push({ token: lastTok, chainIdx: ei, isFirst: false, trendX: lt[0], trendY: lt[1] });
      }
    }

    // Build spatial index for endpoints
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

    var bridgesEvaluated = 0;
    var bridgesAccepted = 0;
    var bridgeEdgeList = [];

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
            if (epB.chainIdx <= epA.chainIdx) continue;
            var tokB = epB.token;

            var gdx = tokB.x - tokA.x, gdy = tokB.y - tokA.y;
            var gap = Math.sqrt(gdx * gdx + gdy * gdy);
            if (gap < 2 || gap > maxGap) continue;

            bridgesEvaluated++;

            // ── Check 1: Directional Agreement (token tangents vs gap vector) ──
            var invGap = 1.0 / gap;
            var gapDirX = gdx * invGap, gapDirY = gdy * invGap;

            var dotA = tokA.tangentX * gapDirX + tokA.tangentY * gapDirY;
            dotA = epA.isFirst ? -dotA : dotA;

            var dotB = tokB.tangentX * gapDirX + tokB.tangentY * gapDirY;
            dotB = epB.isFirst ? dotB : -dotB;

            var tangentDot = Math.abs(tokA.tangentX * tokB.tangentX + tokA.tangentY * tokB.tangentY);

            var dirScore = Math.min(Math.max(dotA, 0), Math.max(dotB, 0));
            dirScore = Math.min(dirScore, tangentDot);
            if (dirScore < dirMin) continue;

            // ── Check 2: Chain-end trend alignment (curve continuity) ──
            var trendDotA = epA.trendX * gapDirX + epA.trendY * gapDirY;
            var trendDotB = epB.trendX * (-gapDirX) + epB.trendY * (-gapDirY);
            var trendScore = Math.min(Math.max(trendDotA, 0), Math.max(trendDotB, 0));

            // ── Composite score (geometry-first) ──
            // Color is a weak tiebreaker — no hard rejection.
            var llD = _labDist(tokA.leftLab, tokB.leftLab);
            var rrD = _labDist(tokA.rightLab, tokB.rightLab);
            var lrD = _labDist(tokA.leftLab, tokB.rightLab);
            var rlD = _labDist(tokA.rightLab, tokB.leftLab);
            var bestColorDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
            var colorScore = Math.max(0, 1.0 - bestColorDist / (bridgeSideTol * 2));
            var gapScore = 1.0 - (gap / maxGap);

            // Geometry-dominant: direction 40%, trend 30%, gap 20%, color 10%
            var combinedScore = dirScore * 0.40 + trendScore * 0.30 +
                                gapScore * 0.20 + colorScore * 0.10;

            if (combinedScore < minCombined) continue;

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
              trendScore: trendScore,
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
   * Compute directional trend at a chain endpoint from the last few tokens.
   * Returns a unit vector pointing outward from the chain end.
   */
  function _chainEndTrend(ids, fromStart, tokenById) {
    var n = ids.length;
    var windowSize = Math.min(4, n);

    var endIdx, refIdx;
    if (fromStart) {
      endIdx = 0;
      refIdx = Math.min(windowSize - 1, n - 1);
    } else {
      endIdx = n - 1;
      refIdx = Math.max(n - windowSize, 0);
    }

    var endTok = tokenById[ids[endIdx]];
    var refTok = tokenById[ids[refIdx]];
    if (!endTok || !refTok) return [0, 0];

    var dx = endTok.x - refTok.x;
    var dy = endTok.y - refTok.y;
    var mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < 0.1) {
      // Fallback to token tangent pointing outward
      if (fromStart) return [-endTok.tangentX, -endTok.tangentY];
      return [endTok.tangentX, endTok.tangentY];
    }
    return [dx / mag, dy / mag];
  }

  /**
   * Order a component's token IDs along the boundary curve.
   * Uses greedy walk from an endpoint (degree-1 node) or arbitrary start.
   */
  function _orderChain(compIds, adjacency, tokenById) {
    var inComp = {};
    for (var i = 0; i < compIds.length; i++) inComp[compIds[i]] = true;

    // Compute component centroid for better start selection
    var cx = 0, cy = 0, cCount = 0;
    for (var ci = 0; ci < compIds.length; ci++) {
      var ct = tokenById[compIds[ci]];
      if (ct) { cx += ct.x; cy += ct.y; cCount++; }
    }
    if (cCount > 0) { cx /= cCount; cy /= cCount; }

    // Find the degree-1 node (endpoint) farthest from centroid.
    // This picks a true extremum rather than an arbitrary first match,
    // leading to longer walks through the component.
    var start = compIds[0];
    var bestEndDist2 = -1;
    var hasEndpoint = false;
    for (var j = 0; j < compIds.length; j++) {
      var deg = 0;
      var neis = adjacency[compIds[j]];
      for (var k = 0; k < neis.length; k++) {
        if (inComp[neis[k]]) deg++;
      }
      if (deg === 1) {
        var et = tokenById[compIds[j]];
        if (et) {
          var edx = et.x - cx, edy = et.y - cy;
          var ed2 = edx * edx + edy * edy;
          if (ed2 > bestEndDist2) {
            bestEndDist2 = ed2;
            start = compIds[j];
            hasEndpoint = true;
          }
        }
      }
    }

    // If no degree-1 node (pure cycle), pick node farthest from centroid
    if (!hasEndpoint) {
      var bestCycleDist2 = -1;
      for (var jc = 0; jc < compIds.length; jc++) {
        var jt = tokenById[compIds[jc]];
        if (jt) {
          var jdx = jt.x - cx, jdy = jt.y - cy;
          var jd2 = jdx * jdx + jdy * jdy;
          if (jd2 > bestCycleDist2) {
            bestCycleDist2 = jd2;
            start = compIds[jc];
          }
        }
      }
    }

    // Forward greedy walk from start: always pick nearest unvisited neighbor
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
      if (best < 0) break; // no unvisited neighbor reachable
      ordered.push(best);
      used[best] = true;
    }

    // Backward walk: extend from the start node in the opposite direction.
    // This recovers the other branch when start was at a junction or when
    // a better path exists behind the chosen start point.
    if (ordered.length < compIds.length) {
      var backward = [];
      var bwCur = ordered[0];
      while (ordered.length + backward.length < compIds.length) {
        var bwTok = tokenById[bwCur];
        var bwBest = -1, bwBestDist = Infinity;
        var bwNeis = adjacency[bwCur];
        for (var bn = 0; bn < bwNeis.length; bn++) {
          var bnid = bwNeis[bn];
          if (!inComp[bnid] || used[bnid]) continue;
          var bnt = tokenById[bnid];
          var bd = (bnt.x - bwTok.x) * (bnt.x - bwTok.x) +
                   (bnt.y - bwTok.y) * (bnt.y - bwTok.y);
          if (bd < bwBestDist) { bwBestDist = bd; bwBest = bnid; }
        }
        if (bwBest < 0) break;
        backward.push(bwBest);
        used[bwBest] = true;
        bwCur = bwBest;
      }
      if (backward.length > 0) {
        backward.reverse();
        ordered = backward.concat(ordered);
      }
    }

    return ordered;
  }

  /**
   * Recover residual tokens dropped by _orderChain.
   *
   * After ordering a component, some tokens may not appear in the ordered
   * chain (due to branching, dense clusters, or greedy walk dead-ends).
   * This function collects those dropped tokens, finds sub-components
   * among them, and returns them as separate chain arrays.
   *
   * BRANCH ANCHOR: For each residual sub-component, we search for a
   * primary-chain token adjacent to it (a "branch point" / junction).
   * If found, that anchor token is prepended to the residual ordering so
   * the recovered arm is explicitly rooted at the T/+-junction rather than
   * appearing as a disconnected fragment.  The anchor token intentionally
   * appears in both the primary chain and the recovered arm — this is
   * correct for branch topology and does not violate the BoundaryGraph
   * contract (adjacency is the authoritative structure).
   *
   * Arms with even a single token are recovered when anchored, so that
   * shallow T-junctions are not silently lost.
   */
  function _recoverResidualChains(compIds, orderedIds, adjacency, tokenById, minLen,
                                  branchAnchorEnabled) {
    if (orderedIds.length >= compIds.length) return []; // nothing dropped

    var inOrdered = {};
    for (var i = 0; i < orderedIds.length; i++) inOrdered[orderedIds[i]] = true;

    // Collect dropped tokens
    var residualSet = {};
    var residual = [];
    for (var ri = 0; ri < compIds.length; ri++) {
      if (!inOrdered[compIds[ri]]) {
        residual.push(compIds[ri]);
        residualSet[compIds[ri]] = true;
      }
    }
    if (residual.length === 0) return [];

    // Find sub-components within residual tokens via existing adjacency
    var visited = {};
    var subChains = [];
    for (var si = 0; si < residual.length; si++) {
      var tid = residual[si];
      if (visited[tid]) continue;

      var comp = [];
      var queue = [tid];
      visited[tid] = true;
      while (queue.length > 0) {
        var cur = queue.shift();
        comp.push(cur);
        var neis = adjacency[cur] || [];
        for (var ni = 0; ni < neis.length; ni++) {
          var nid = neis[ni];
          if (!visited[nid] && residualSet[nid]) {
            visited[nid] = true;
            queue.push(nid);
          }
        }
      }

      // ── Branch anchor search ──
      // Find the best primary-chain token adjacent to this sub-component.
      // "Best" = the one with the most connections into the residual arm
      // (favours genuine junction tokens over incidental neighbours).
      var anchor = -1;
      if (branchAnchorEnabled !== false) {
        var anchorConnCount = 0;
        for (var ci = 0; ci < comp.length; ci++) {
          var compNeis = adjacency[comp[ci]] || [];
          for (var cni = 0; cni < compNeis.length; cni++) {
            var cnid = compNeis[cni];
            if (!inOrdered[cnid]) continue;
            // Count how many comp tokens this ordered neighbour is adjacent to
            var connCount = 0;
            var onNeis = adjacency[cnid] || [];
            for (var oni = 0; oni < onNeis.length; oni++) {
              if (residualSet[onNeis[oni]]) connCount++;
            }
            if (connCount > anchorConnCount) {
              anchorConnCount = connCount;
              anchor = cnid;
            }
          }
        }
      }

      // Determine effective minimum length:
      // With an anchor the arm contributes one extra token (the junction),
      // so a 1-token arm + anchor = length-2 ordered chain, which is valid.
      // Without an anchor, use the caller-supplied minLen.
      var effectiveMin = (anchor >= 0) ? 1 : minLen;

      if (comp.length >= effectiveMin) {
        // Build the token set for ordering: include anchor first if present
        var tokensForOrdering = anchor >= 0 ? [anchor].concat(comp) : comp;
        var ordered = _orderChain(tokensForOrdering, adjacency, tokenById);
        if (ordered.length >= 2) subChains.push(ordered);
      }
    }
    return subChains;
  }

  /* ================================================================
   *  Chain Endpoint Continuation (token-native)
   *
   *  For each chain endpoint, search for compatible unlinked tokens
   *  along the chain's directional trend. Extension decisions are
   *  based entirely on token properties:
   *    - directional trend from recent chain tokens
   *    - tangent alignment of candidate
   *    - sided color compatibility
   *    - spacing consistency
   *    - directional drift detection (stop if trend is lost)
   *
   *  No image evidence maps are consulted.
   * ================================================================ */

  function _extendChainEndpoints(chains, adjacency, tokenById, cfg) {
    var maxDist = cfg.chainExtensionMaxDist || 40;
    var dirMin = cfg.chainExtensionDirAlign || 0.50;
    var colorTol = cfg.chainExtensionColorTol || 40;
    var trendWindow = cfg.chainExtensionTrendWindow || 4;
    var maxDirDrift = cfg.chainExtensionMaxDirDrift || 0.40;
    var corridorHW = 8; // lateral half-width for candidate search

    // Microchaining configuration
    var microchainCfg = null;
    if (cfg.microchainEnabled !== false) {
      microchainCfg = {
        enabled:          true,
        minCandidates:    cfg.microchainMinCandidates || 3,
        coherenceThresh:  cfg.microchainCoherenceThresh != null ? cfg.microchainCoherenceThresh : 0.50,
        driftRelief:      cfg.microchainDriftRelief != null ? cfg.microchainDriftRelief : 0.50,
        supportDecay:     cfg.microchainSupportDecay != null ? cfg.microchainSupportDecay : 0.85,
        supportFloor:     cfg.microchainSupportFloor != null ? cfg.microchainSupportFloor : 0.15
      };
    }

    // Lookahead configuration
    var lookaheadCfg = null;
    if (cfg.lookaheadEnabled !== false) {
      lookaheadCfg = {
        enabled:            true,
        maxDepth:           cfg.lookaheadMaxDepth || 6,
        scoreWeight:        cfg.lookaheadScoreWeight != null ? cfg.lookaheadScoreWeight : 0.25,
        driftRescueDepth:   cfg.lookaheadDriftRescueDepth || 2,
        coherenceFraction:  cfg.lookaheadCoherenceFraction != null ? cfg.lookaheadCoherenceFraction : 0.30,
        beamWidth:          cfg.lookaheadBeamWidth != null ? cfg.lookaheadBeamWidth : 2,
        densityRadius:      cfg.lookaheadDensityRadius != null ? cfg.lookaheadDensityRadius : 12,
        densityWeight:      cfg.lookaheadDensityWeight != null ? cfg.lookaheadDensityWeight : 0.10
      };
    }

    // XY trend configuration
    var xyTrendCfg = null;
    if (cfg.xyTrendEnabled !== false) {
      xyTrendCfg = {
        enabled:         true,
        windowSize:      cfg.xyTrendWindowSize != null ? cfg.xyTrendWindowSize : 10,
        minTokens:       cfg.xyTrendMinTokens  != null ? cfg.xyTrendMinTokens  : 4,
        blendWeight:     cfg.xyTrendBlendWeight != null ? cfg.xyTrendBlendWeight : 0.30,
        consistencyMin:  cfg.xyTrendConsistencyMin != null ? cfg.xyTrendConsistencyMin : 0.65
      };
    }

    // Build spatial grid for fast token lookup
    var extCellSize = 10;
    var extGrid = {};
    for (var tkey in tokenById) {
      var tok = tokenById[tkey];
      var egk = ((tok.x / extCellSize) | 0) + ',' + ((tok.y / extCellSize) | 0);
      if (!extGrid[egk]) extGrid[egk] = [];
      extGrid[egk].push(tok);
    }

    // Track which tokens are already in a chain
    var tokenToChain = {};
    for (var ci2 = 0; ci2 < chains.length; ci2++) {
      var cids = chains[ci2].ids;
      for (var cj = 0; cj < cids.length; cj++) tokenToChain[cids[cj]] = ci2;
    }

    for (var ci = 0; ci < chains.length; ci++) {
      var chain = chains[ci];
      var ids = chain.ids;
      if (ids.length < 2) continue;

      _tokenExtend(ids, false, tokenById, adjacency,
                   extGrid, extCellSize, tokenToChain, chains, ci,
                   maxDist, dirMin, colorTol, corridorHW, trendWindow, maxDirDrift,
                   microchainCfg, lookaheadCfg, xyTrendCfg);
      _tokenExtend(ids, true, tokenById, adjacency,
                   extGrid, extCellSize, tokenToChain, chains, ci,
                   maxDist, dirMin, colorTol, corridorHW, trendWindow, maxDirDrift,
                   microchainCfg, lookaheadCfg, xyTrendCfg);
    }
  }

  /**
   * Token-native chain extension from one endpoint.
   *
   * MICROCHAINING: Rather than committing to the single nearest candidate
   * in isolation, the extension now considers the local population of
   * strict-valid candidates as reinforcing evidence. When many candidates
   * directionally agree (a "microchain cluster"), that population support:
   *   1) Selects the best-scoring coherent candidate (not just nearest)
   *   2) Builds accumulated support momentum that makes the drift gate
   *      more resilient — a single slightly-awkward step won't kill a
   *      chain that has strong ongoing local reinforcement
   *   3) Allows support to decay gracefully so chains die only when
   *      strict local reinforcement truly collapses
   *
   * Strict validity is unchanged: every candidate still passes the same
   * distance, tangent, corridor, and color filters. Microchaining only
   * changes how much of that strict evidence participates in the decision.
   */
  function _tokenExtend(ids, fromStart, tokenById, adjacency,
                        extGrid, extCellSize, tokenToChain, allChains, myChainIdx,
                        maxDist, dirMin, colorTol, corridorHW, trendWindow, maxDirDrift,
                        microchainCfg, lookaheadCfg, xyTrendCfg) {
    if (ids.length < 2) return;

    // Compute initial chain-end direction from recent tokens
    var dir = _computeChainEndDirection(ids, fromStart, tokenById, trendWindow);
    if (!dir) return;
    var dirX = dir[0], dirY = dir[1];
    var perpX = -dirY, perpY = dirX;

    // Track a rolling baseline for drift detection (updated periodically)
    // This allows smooth curves to extend while still catching wandering.
    var baseDirX = dirX, baseDirY = dirY;
    var stepsSinceBaseUpdate = 0;
    var baseUpdateInterval = 3; // re-anchor baseline every N extensions

    // Microchaining state: accumulated support momentum.
    // Starts at 0 (no history); builds as coherent populations are found;
    // decays each step so that weakening evidence gradually reduces relief.
    var mcEnabled = microchainCfg && microchainCfg.enabled;
    var mcMinCandidates = mcEnabled ? microchainCfg.minCandidates : 0;
    var mcCoherenceThresh = mcEnabled ? microchainCfg.coherenceThresh : 0;
    var mcDriftRelief = mcEnabled ? microchainCfg.driftRelief : 0;
    var mcSupportDecay = mcEnabled ? microchainCfg.supportDecay : 0;
    var mcSupportFloor = mcEnabled ? microchainCfg.supportFloor : 0;
    var accumulatedSupport = 0; // 0..1, builds over steps

    // Lookahead state
    var laEnabled = lookaheadCfg && lookaheadCfg.enabled;
    var laMaxDepth = laEnabled ? lookaheadCfg.maxDepth : 0;
    var laScoreWeight = laEnabled ? lookaheadCfg.scoreWeight : 0;
    var laDriftRescueDepth = laEnabled ? lookaheadCfg.driftRescueDepth : 0;
    var laCoherenceFraction = laEnabled ? (lookaheadCfg.coherenceFraction || 0.30) : 0;
    var laBeamWidth = laEnabled ? (lookaheadCfg.beamWidth || 2) : 1;
    var laDensityRadius = laEnabled ? (lookaheadCfg.densityRadius || 12) : 0;
    var laDensityWeight = laEnabled ? (lookaheadCfg.densityWeight || 0.10) : 0;

    // XY trend state
    var xtEnabled = xyTrendCfg && xyTrendCfg.enabled;
    var xtWindowSize = xtEnabled ? (xyTrendCfg.windowSize || 10) : 0;
    var xtMinTokens  = xtEnabled ? (xyTrendCfg.minTokens  || 4)  : 0;
    var xtBlendWeight    = xtEnabled ? (xyTrendCfg.blendWeight    || 0.30) : 0;
    var xtConsistencyMin = xtEnabled ? (xyTrendCfg.consistencyMin || 0.65) : 0;

    var inChain = {};
    for (var vi = 0; vi < ids.length; vi++) inChain[ids[vi]] = true;

    var endIdx = fromStart ? 0 : ids.length - 1;
    var endTok = tokenById[ids[endIdx]];
    if (!endTok) return;

    var extensionCount = 0;
    var maxExtensions = 15;

    while (extensionCount < maxExtensions) {
      extensionCount++;

      // Search for candidate tokens ahead of the endpoint.
      // Use the full maxDist as search horizon — directional alignment
      // and drift detection prevent false positives, not distance caps.
      var candidates = [];
      var searchRadius = maxDist;

      // Scan along the direction and collect candidates from spatial grid
      for (var si = 1; si <= searchRadius; si += extCellSize * 0.5) {
        var scanX = endTok.x + dirX * si;
        var scanY = endTok.y + dirY * si;
        var sgx = (scanX / extCellSize) | 0;
        var sgy = (scanY / extCellSize) | 0;
        for (var gdy = -1; gdy <= 1; gdy++) {
          for (var gdx = -1; gdx <= 1; gdx++) {
            var gk = (sgx + gdx) + ',' + (sgy + gdy);
            var bucket = extGrid[gk];
            if (!bucket) continue;
            for (var bi = 0; bi < bucket.length; bi++) {
              var cand = bucket[bi];
              if (inChain[cand.id]) continue;

              // Project candidate onto the chain's directional axis
              var relX = cand.x - endTok.x;
              var relY = cand.y - endTok.y;
              var along = relX * dirX + relY * dirY;
              var across = Math.abs(relX * perpX + relY * perpY);

              if (along < 1 || along > maxDist || across > corridorHW) continue;

              // Tangent alignment: candidate tangent vs chain direction
              var tokDirDot = Math.abs(cand.tangentX * dirX + cand.tangentY * dirY);
              // Also check alignment with endpoint tangent (handles gentle curves)
              var tokEndDot = Math.abs(cand.tangentX * endTok.tangentX +
                                       cand.tangentY * endTok.tangentY);
              var bestDirScore = Math.max(tokDirDot, tokEndDot);
              if (bestDirScore < dirMin) continue;

              // Sided color compatibility — soft factor, no hard veto.
              var llD = _labDist(endTok.leftLab, cand.leftLab);
              var rrD = _labDist(endTok.rightLab, cand.rightLab);
              var lrD = _labDist(endTok.leftLab, cand.rightLab);
              var rlD = _labDist(endTok.rightLab, cand.leftLab);
              var cDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
              var extColorScore = Math.max(0, 1.0 - cDist / colorTol);

              // Score: geometry-dominant. Color is a weak tiebreaker.
              var score = bestDirScore * 0.40 +
                          (1.0 - along / maxDist) * 0.30 +
                          (1.0 - across / corridorHW) * 0.20 +
                          extColorScore * 0.10;

              candidates.push({ tok: cand, score: score, along: along });
            }
          }
        }
      }

      if (candidates.length === 0) break;

      // Deduplicate (same token may be found from multiple scan steps)
      var seen = {};
      var uniqueCandidates = [];
      for (var ui = 0; ui < candidates.length; ui++) {
        if (!seen[candidates[ui].tok.id]) {
          seen[candidates[ui].tok.id] = true;
          uniqueCandidates.push(candidates[ui]);
        }
      }
      candidates = uniqueCandidates;

      /* ── Microchaining: local strict-link population analysis ──
       *
       * When enough strict-valid candidates exist, measure how many
       * directionally agree with the chain's continuation trend.
       * This "microchain support" represents the density of local
       * strict evidence reinforcing the same boundary direction.
       */
      var mcActive = mcEnabled && candidates.length >= mcMinCandidates;
      var stepSupport = 0;

      if (mcActive) {
        var mc = _microchainSupport(candidates, dirX, dirY, mcCoherenceThresh);
        stepSupport = mc.support;
        accumulatedSupport = accumulatedSupport * mcSupportDecay + stepSupport * (1.0 - mcSupportDecay);
      } else {
        accumulatedSupport = accumulatedSupport * mcSupportDecay;
      }

      /* ── Lookahead: short-horizon continuation probe ──
       *
       * For each candidate, simulate a short greedy continuation from
       * that candidate to see how many strict-valid steps exist beyond it.
       * This "future depth" reveals whether a candidate opens into a
       * coherent continuation or immediately dead-ends.
       *
       * Two effects:
       * 1. Candidate ranking: a candidate's final score is blended with
       *    its lookahead score, so candidates with deeper valid futures
       *    are preferred over shallow dead-ends.
       * 2. Drift rescue: if the best candidate would normally fail the
       *    drift gate, but its lookahead shows ≥ driftRescueDepth valid
       *    future steps, the chain is allowed to continue. This is the
       *    key mechanism that prevents premature mid-boundary death:
       *    a slightly awkward immediate step is tolerated when the short
       *    horizon clearly confirms the boundary continues.
       */
      var selectedCandidate;
      var selectedLookahead = null; // { depth, score } of selected candidate

      if (laEnabled && candidates.length > 0) {
        // Score each candidate with lookahead-augmented ranking.
        // To keep cost bounded, only probe the top candidates (by base score).
        candidates.sort(function(a, b) { return b.score - a.score; });
        var probeLimit = Math.min(candidates.length, 5); // probe top 5 at most

        var bestAugScore = -1;
        var bestAugIdx = 0;
        var bestAugLA = null;

        for (var pi = 0; pi < probeLimit; pi++) {
          var probeCand = candidates[pi];
          var probeTok = probeCand.tok;

          // Compute probe direction: blend chain direction with step direction
          // so the probe follows the trajectory this candidate would establish
          var stepDx = probeTok.x - endTok.x;
          var stepDy = probeTok.y - endTok.y;
          var stepMag = Math.sqrt(stepDx * stepDx + stepDy * stepDy);
          var pDirX = dirX, pDirY = dirY;
          if (stepMag > 0.1) {
            pDirX = (stepDx / stepMag) * 0.6 + dirX * 0.4;
            pDirY = (stepDy / stepMag) * 0.6 + dirY * 0.4;
            var pMag = Math.sqrt(pDirX * pDirX + pDirY * pDirY);
            if (pMag > 0.1) { pDirX /= pMag; pDirY /= pMag; }
            else { pDirX = dirX; pDirY = dirY; }
          }

          var la = _lookaheadProbe(probeTok, pDirX, pDirY,
                                   extGrid, extCellSize, inChain, tokenById,
                                   maxDist, dirMin, colorTol, corridorHW, laMaxDepth,
                                   laBeamWidth, laDensityRadius, laDensityWeight);

          // Augmented score: base score + lookahead composite.
          // The lookahead composite blends depth/quality with direction
          // coherence (stable curvature preference). Coherence fraction
          // controls how much of the lookahead weight is coherence vs
          // depth/quality. Total lookahead influence = laScoreWeight (25%).
          // Max coherence influence = laScoreWeight × coherenceFraction = 7.5%.
          // Local base score always dominates at (1 - laScoreWeight) = 75%.
          var laComposite = la.score * (1.0 - laCoherenceFraction) +
                            la.coherenceScore * laCoherenceFraction;
          var augScore = probeCand.score * (1.0 - laScoreWeight) + laComposite * laScoreWeight;

          if (augScore > bestAugScore) {
            bestAugScore = augScore;
            bestAugIdx = pi;
            bestAugLA = la;
          }
        }

        selectedCandidate = candidates[bestAugIdx];
        selectedLookahead = bestAugLA;
      } else if (mcActive && mc.bestCandidate) {
        // Microchaining without lookahead: use coherent population best
        selectedCandidate = mc.bestCandidate;
      } else {
        // Fallback: sort by distance, take nearest
        candidates.sort(function(a, b) { return a.along - b.along; });
        selectedCandidate = candidates[0];
      }

      var nearTok = selectedCandidate.tok;

      /* ── Drift detection with lookahead rescue ──
       *
       * The drift gate compares the step direction against the rolling
       * baseline. Microchaining can widen the threshold when accumulated
       * support is strong.
       *
       * LOOKAHEAD RESCUE: If the immediate step exceeds the drift threshold
       * but the lookahead probe found ≥ driftRescueDepth valid continuation
       * steps beyond this candidate, the chain is NOT terminated. This is
       * the critical behavioral change: a slightly awkward step that opens
       * into a clearly valid short-horizon future is treated as part of a
       * gentle curve rather than a termination event.
       *
       * Safeguard: rescue only applies within a bounded overshoot zone
       * (up to 2x the drift threshold). Truly divergent steps still kill
       * the chain even with a valid future — they indicate a fork or
       * cross-boundary jump, not a gentle curve.
       */
      var newDir = _computeDirectionTo(endTok, nearTok);
      if (newDir) {
        var driftFromBase = 1.0 - Math.abs(newDir[0] * baseDirX + newDir[1] * baseDirY);

        // Compute effective drift threshold with microchain relief
        var effectiveDriftMax = maxDirDrift;
        if (mcEnabled && accumulatedSupport > mcSupportFloor) {
          var reliefFactor = (accumulatedSupport - mcSupportFloor) / (1.0 - mcSupportFloor);
          effectiveDriftMax = maxDirDrift * (1.0 + mcDriftRelief * reliefFactor);
        }

        if (driftFromBase > effectiveDriftMax) {
          // Immediate step exceeds drift threshold — check for lookahead rescue
          var rescued = false;
          if (laEnabled && selectedLookahead && selectedLookahead.depth >= laDriftRescueDepth) {
            // Only rescue within a bounded overshoot zone (up to 2x threshold).
            // Beyond that, the step is too divergent regardless of future.
            if (driftFromBase <= effectiveDriftMax * 2.0) {
              rescued = true;
            }
          }
          if (!rescued) break;
        }
      }

      // Link it
      adjacency[endTok.id].push(nearTok.id);
      adjacency[nearTok.id].push(endTok.id);

      // Check if this token belongs to another chain — merge if so
      var otherChainIdx = tokenToChain[nearTok.id];
      if (otherChainIdx != null && otherChainIdx !== myChainIdx) {
        var otherIds = allChains[otherChainIdx].ids;
        for (var mi = 0; mi < otherIds.length; mi++) {
          if (!inChain[otherIds[mi]]) {
            ids.push(otherIds[mi]);
            inChain[otherIds[mi]] = true;
            tokenToChain[otherIds[mi]] = myChainIdx;
          }
        }
        allChains[otherChainIdx].ids = [];
        break;
      }

      // Add to chain
      ids.push(nearTok.id);
      inChain[nearTok.id] = true;
      tokenToChain[nearTok.id] = myChainIdx;
      endTok = nearTok;

      // Update direction from the new chain tail
      var updatedDir = _computeChainEndDirection(ids, fromStart, tokenById, trendWindow);
      if (updatedDir) {
        dirX = updatedDir[0]; dirY = updatedDir[1];
        perpX = -dirY; perpY = dirX;
      }

      // ── XY trend blending ──
      // When the recent chain tokens form a clearly coherent spatial
      // arrangement (high PCA explained variance), blend the PCA-derived
      // direction into the current extension direction. This compensates
      // for noisy individual token tangents that cause the local direction
      // estimate to jitter, and helps the chain follow the larger visible
      // edge/line structure rather than fragmenting at noisy transitions.
      //
      // Blend is proportional to consistency above the threshold, so it
      // fades gracefully as coherence decreases. Local evidence always
      // dominates: even at max blend, xtBlendWeight caps the influence.
      if (xtEnabled && ids.length >= xtMinTokens) {
        var xtWindow = Math.min(xtWindowSize, ids.length);
        var xtTokens = [];
        if (fromStart) {
          for (var xti = 0; xti < xtWindow; xti++) {
            var xtt = tokenById[ids[xti]]; if (xtt) xtTokens.push(xtt);
          }
        } else {
          for (var xti2 = ids.length - xtWindow; xti2 < ids.length; xti2++) {
            var xtt2 = tokenById[ids[xti2]]; if (xtt2) xtTokens.push(xtt2);
          }
        }
        if (xtTokens.length >= xtMinTokens) {
          var xtDir = _computeXYTrendDir(xtTokens);
          if (xtDir) {
            var xtConsistency = _xyTrendConsistency(xtTokens, xtDir);
            if (xtConsistency >= xtConsistencyMin) {
              // Sign-align the unsigned PCA axis with the current direction
              var xtSignDot = xtDir[0] * dirX + xtDir[1] * dirY;
              if (xtSignDot < 0) { xtDir[0] = -xtDir[0]; xtDir[1] = -xtDir[1]; }
              // Blend amount scales linearly with consistency above threshold
              var xtBlend = xtBlendWeight *
                            ((xtConsistency - xtConsistencyMin) / (1.0 - xtConsistencyMin));
              var xtBX = dirX * (1.0 - xtBlend) + xtDir[0] * xtBlend;
              var xtBY = dirY * (1.0 - xtBlend) + xtDir[1] * xtBlend;
              var xtBMag = Math.sqrt(xtBX * xtBX + xtBY * xtBY);
              if (xtBMag > 0.1) {
                dirX = xtBX / xtBMag; dirY = xtBY / xtBMag;
                perpX = -dirY; perpY = dirX;
              }
            }
          }
        }
      }

      // Periodically re-anchor the drift baseline so smooth curves
      // can accumulate gradual direction change without terminating.
      stepsSinceBaseUpdate++;
      if (stepsSinceBaseUpdate >= baseUpdateInterval) {
        baseDirX = dirX; baseDirY = dirY;
        stepsSinceBaseUpdate = 0;
      }
    }
  }

  /** Compute outward direction at a chain endpoint from the last N tokens. */
  function _computeChainEndDirection(ids, fromStart, tokenById, window) {
    var n = ids.length;
    var w = Math.min(window || 4, n);

    var endIdx, d1Idx, d2Idx;
    if (fromStart) {
      endIdx = 0; d1Idx = 1; d2Idx = Math.min(w - 1, n - 1);
    } else {
      endIdx = n - 1; d1Idx = n - 2; d2Idx = Math.max(n - w, 0);
    }
    var endTok = tokenById[ids[endIdx]];
    var d1Tok = tokenById[ids[d1Idx]];
    var d2Tok = tokenById[ids[d2Idx]];
    if (!endTok || !d1Tok) return null;

    var dx1 = endTok.x - d1Tok.x, dy1 = endTok.y - d1Tok.y;
    var dx2 = endTok.x - d2Tok.x, dy2 = endTok.y - d2Tok.y;
    var mag1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    var mag2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

    if (mag1 < 0.1 && mag2 < 0.1) return null;
    if (mag2 < 0.1 || d2Idx === d1Idx) {
      return [dx1 / mag1, dy1 / mag1];
    }
    var n1x = dx1 / mag1, n1y = dy1 / mag1;
    var n2x = dx2 / mag2, n2y = dy2 / mag2;
    var dirX = n1x * 0.7 + n2x * 0.3;
    var dirY = n1y * 0.7 + n2y * 0.3;
    var dm = Math.sqrt(dirX * dirX + dirY * dirY);
    if (dm < 0.1) return null;
    return [dirX / dm, dirY / dm];
  }

  /**
   * Lookahead probe: simulate a short continuation from a candidate token to
   * evaluate the quality of the future path beyond it.
   *
   * This is a READ-ONLY probe — no links are committed, no state is mutated.
   * Each probe step applies the same strict validity filters used by the real
   * extension loop (distance, corridor, tangent alignment, color).
   *
   * BEAM SEARCH: At each step, the probe expands the top `beamWidth` candidates
   * rather than a single greedy pick. All beams advance in parallel; only the
   * best-scoring beam path is kept at each level. This makes the probe
   * significantly better at finding valid futures through ambiguous transitions
   * where a single greedy step would dead-end.
   *
   * DENSITY BONUS: Candidates surrounded by other nearby tokens (not in-chain)
   * receive a small bonus score. This represents "structural richness ahead" —
   * leading into a denser token field is generally better than stepping into an
   * empty region. It gives a positive signal even when the path dead-ends at
   * the next step but the candidate sits in a meaningful token cluster.
   *
   * Returns:
   *   depth:          valid continuation steps found (0..maxDepth)
   *   score:          0..1, quality-weighted depth ratio
   *   coherenceScore: 0..1, direction stability of the probed path
   *
   * @param {Object} startTok      - candidate token to probe from
   * @param {number} probeDirX/Y   - initial probe direction (unit vector)
   * @param {Object} extGrid       - spatial grid for token lookup
   * @param {number} extCellSize   - grid cell size
   * @param {Object} inChain       - set of token IDs already in the chain
   * @param {Object} tokenById     - token lookup
   * @param {number} maxDist       - max step distance
   * @param {number} dirMin        - min tangent alignment
   * @param {number} colorTol      - color tolerance
   * @param {number} corridorHW    - lateral half-width
   * @param {number} maxDepth      - max probe steps
   * @param {number} beamWidth     - candidates to try at each step (default 1 = greedy)
   * @param {number} densityRadius - radius for density count bonus (0 = disabled)
   * @param {number} densityWeight - max score bonus from density (0 = disabled)
   */
  function _lookaheadProbe(startTok, probeDirX, probeDirY,
                           extGrid, extCellSize, inChain, tokenById,
                           maxDist, dirMin, colorTol, corridorHW, maxDepth,
                           beamWidth, densityRadius, densityWeight) {
    beamWidth = beamWidth || 1;
    densityRadius = densityRadius || 0;
    densityWeight = densityWeight || 0;

    // ── Beam state ──
    // Each beam: { curTok, curDirX, curDirY, probeUsed, stepDirXs, stepDirYs,
    //              totalQuality, depth }
    // We track all active beams across steps and keep only top beamWidth
    // by combined score at each level, then return the best survivor.
    var beams = [{
      curTok:       startTok,
      curDirX:      probeDirX,
      curDirY:      probeDirY,
      probeUsed:    {},    // shallow copy per beam branch below
      stepDirXs:    [],
      stepDirYs:    [],
      totalQuality: 0,
      depth:        0
    }];
    beams[0].probeUsed[startTok.id] = true;

    for (var step = 0; step < maxDepth; step++) {
      var nextBeams = [];

      for (var bi = 0; bi < beams.length; bi++) {
        var bm = beams[bi];
        var perpX = -bm.curDirY, perpY = bm.curDirX;

        // ── Collect all strict-valid candidates from this beam position ──
        var stepCands = [];

        for (var si = 1; si <= maxDist; si += extCellSize * 0.5) {
          var scanX = bm.curTok.x + bm.curDirX * si;
          var scanY = bm.curTok.y + bm.curDirY * si;
          var sgx = (scanX / extCellSize) | 0;
          var sgy = (scanY / extCellSize) | 0;
          for (var gdy = -1; gdy <= 1; gdy++) {
            for (var gdx = -1; gdx <= 1; gdx++) {
              var gk = (sgx + gdx) + ',' + (sgy + gdy);
              var bucket = extGrid[gk];
              if (!bucket) continue;
              for (var bki = 0; bki < bucket.length; bki++) {
                var cand = bucket[bki];
                if (inChain[cand.id] || bm.probeUsed[cand.id]) continue;

                var relX = cand.x - bm.curTok.x;
                var relY = cand.y - bm.curTok.y;
                var along = relX * bm.curDirX + relY * bm.curDirY;
                var across = Math.abs(relX * perpX + relY * perpY);

                if (along < 1 || along > maxDist || across > corridorHW) continue;

                var tokDirDot = Math.abs(cand.tangentX * bm.curDirX + cand.tangentY * bm.curDirY);
                var tokEndDot = Math.abs(cand.tangentX * bm.curTok.tangentX +
                                         cand.tangentY * bm.curTok.tangentY);
                var dirScore = Math.max(tokDirDot, tokEndDot);
                if (dirScore < dirMin) continue;

                var llD = _labDist(bm.curTok.leftLab, cand.leftLab);
                var rrD = _labDist(bm.curTok.rightLab, cand.rightLab);
                var lrD = _labDist(bm.curTok.leftLab, cand.rightLab);
                var rlD = _labDist(bm.curTok.rightLab, cand.leftLab);
                var cDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
                var colorScore = Math.max(0, 1.0 - cDist / colorTol);

                var score = dirScore * 0.40 +
                            (1.0 - along / maxDist) * 0.30 +
                            (1.0 - across / corridorHW) * 0.20 +
                            colorScore * 0.10;

                // ── Density bonus: nearby non-chain tokens signal structural richness ──
                // Counts tokens within densityRadius that are neither in-chain
                // nor already consumed by this beam. A denser neighbourhood is
                // a positive signal for downstream continuability, even if this
                // specific probe dead-ends at the next step.
                if (densityWeight > 0 && densityRadius > 0) {
                  var densCount = 0;
                  var densR2 = densityRadius * densityRadius;
                  var densCellR = Math.ceil(densityRadius / extCellSize);
                  var dcx = (cand.x / extCellSize) | 0;
                  var dcy = (cand.y / extCellSize) | 0;
                  for (var ddy = -densCellR; ddy <= densCellR; ddy++) {
                    for (var ddx = -densCellR; ddx <= densCellR; ddx++) {
                      var dk = (dcx + ddx) + ',' + (dcy + ddy);
                      var dbucket = extGrid[dk];
                      if (!dbucket) continue;
                      for (var dbi = 0; dbi < dbucket.length; dbi++) {
                        var dt = dbucket[dbi];
                        if (dt.id === cand.id || inChain[dt.id] || bm.probeUsed[dt.id]) continue;
                        var ddxr = dt.x - cand.x, ddyr = dt.y - cand.y;
                        if (ddxr * ddxr + ddyr * ddyr <= densR2) densCount++;
                      }
                    }
                  }
                  // Saturate at 5 neighbours: beyond that the density is clearly high
                  score += densityWeight * Math.min(1.0, densCount / 5.0);
                }

                stepCands.push({ tok: cand, score: score, along: along });
              }
            }
          }
        }

        if (stepCands.length === 0) {
          // This beam dead-ends here — preserve it at current depth so it
          // still contributes its accumulated quality to the final ranking.
          nextBeams.push(bm);
          continue;
        }

        // Sort and pick top beamWidth candidates to expand this beam
        stepCands.sort(function(a, b) { return b.score - a.score; });
        var toExpand = Math.min(stepCands.length, beamWidth);

        for (var ei = 0; ei < toExpand; ei++) {
          var sc = stepCands[ei];

          // Update probe direction: blend step direction with beam direction
          var stepDx = sc.tok.x - bm.curTok.x;
          var stepDy = sc.tok.y - bm.curTok.y;
          var stepMag = Math.sqrt(stepDx * stepDx + stepDy * stepDy);
          var newDirX = bm.curDirX, newDirY = bm.curDirY;
          var rawStepX = bm.curDirX, rawStepY = bm.curDirY;
          if (stepMag > 0.1) {
            rawStepX = stepDx / stepMag;
            rawStepY = stepDy / stepMag;
            var blendX = rawStepX * 0.6 + bm.curDirX * 0.4;
            var blendY = rawStepY * 0.6 + bm.curDirY * 0.4;
            var blendMag = Math.sqrt(blendX * blendX + blendY * blendY);
            if (blendMag > 0.1) { newDirX = blendX / blendMag; newDirY = blendY / blendMag; }
          }

          // Create child beam (shallow copy of probeUsed with new entry)
          var childUsed = {};
          for (var uk in bm.probeUsed) childUsed[uk] = true;
          childUsed[sc.tok.id] = true;

          var childStepDirXs = bm.stepDirXs.slice();
          var childStepDirYs = bm.stepDirYs.slice();
          childStepDirXs.push(rawStepX);
          childStepDirYs.push(rawStepY);

          nextBeams.push({
            curTok:       sc.tok,
            curDirX:      newDirX,
            curDirY:      newDirY,
            probeUsed:    childUsed,
            stepDirXs:    childStepDirXs,
            stepDirYs:    childStepDirYs,
            totalQuality: bm.totalQuality + sc.score,
            depth:        bm.depth + 1
          });
        }
      }

      if (nextBeams.length === 0) break;

      // Rank beams by (totalQuality / max(depth, 1)) descending,
      // keep only top beamWidth so cost stays bounded
      nextBeams.sort(function(a, b) {
        var qa = a.totalQuality / Math.max(a.depth, 1);
        var qb = b.totalQuality / Math.max(b.depth, 1);
        return qb - qa;
      });
      beams = nextBeams.slice(0, beamWidth);
    }

    // ── Select best beam ──
    // Among all surviving beams, pick the one with the greatest depth,
    // breaking ties by total quality.
    var bestBeam = beams[0];
    for (var fi = 1; fi < beams.length; fi++) {
      var candidate = beams[fi];
      if (candidate.depth > bestBeam.depth ||
          (candidate.depth === bestBeam.depth &&
           candidate.totalQuality > bestBeam.totalQuality)) {
        bestBeam = candidate;
      }
    }

    var depth = bestBeam ? bestBeam.depth : 0;
    var totalQuality = bestBeam ? bestBeam.totalQuality : 0;
    var stepDirXs = bestBeam ? bestBeam.stepDirXs : [];
    var stepDirYs = bestBeam ? bestBeam.stepDirYs : [];

    // ── Direction coherence ──
    // Average dot product between consecutive step directions:
    //   ~1.0 = straight or smoothly curving (structurally clean)
    //   ~0.7 = mild jitter or gentle curve changes (acceptable)
    //   < 0.5 = zigzag / reversing path (structurally weak)
    // Neutral value 0.5 for paths too short to compare.
    var coherenceScore = 0.5;
    if (stepDirXs.length >= 2) {
      var dotSum = 0;
      for (var di = 0; di < stepDirXs.length - 1; di++) {
        dotSum += stepDirXs[di] * stepDirXs[di + 1] + stepDirYs[di] * stepDirYs[di + 1];
      }
      var avgDot = dotSum / (stepDirXs.length - 1);
      coherenceScore = (avgDot + 1.0) * 0.5;
    }

    return {
      depth: depth,
      score: maxDepth > 0 ? (depth / maxDepth) * (depth > 0 ? totalQuality / depth : 0) : 0,
      coherenceScore: coherenceScore
    };
  }

  /**
   * Microchain support: analyze a population of strict-valid candidates
   * for directionally coherent reinforcement.
   *
   * Given the current chain direction and a set of already-filtered
   * (strict-valid) candidates, compute how much local evidence
   * coherently supports continuation in that direction.
   *
   * Returns:
   *   support:   0..1  (fraction of candidates that coherently agree)
   *   density:   number of coherent candidates
   *   bestCandidate: the highest-scoring candidate from the coherent set
   *                  (null if no coherent cluster found)
   *
   * This does NOT loosen validity — candidates were already strict-filtered.
   * It measures how much of the local strict population reinforces the
   * same continuation trend.
   */
  function _microchainSupport(candidates, dirX, dirY, coherenceThresh) {
    if (candidates.length === 0) {
      return { support: 0, density: 0, bestCandidate: null };
    }
    if (candidates.length === 1) {
      return { support: 0, density: 1, bestCandidate: candidates[0] };
    }

    // For each candidate, compute its step direction from the endpoint
    // (already implicit in the along/across projection, but we need
    // the direction relative to chain direction for coherence testing).
    //
    // A candidate is "coherent" if its implied continuation direction
    // aligns with the overall chain direction above coherenceThresh.
    // We use the candidate's tangent alignment with chain direction
    // as a proxy — candidates that passed strict filtering already have
    // tangent alignment, but coherence measures how much they agree
    // with the *chain's* continuation trend specifically.

    var coherentCount = 0;
    var bestScore = -1;
    var bestCand = null;

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var tok = c.tok;

      // Candidate tangent alignment with chain direction
      // (using absolute dot because tangent is orientation-agnostic)
      var tangentCoherence = Math.abs(tok.tangentX * dirX + tok.tangentY * dirY);

      if (tangentCoherence >= coherenceThresh) {
        coherentCount++;
        if (c.score > bestScore) {
          bestScore = c.score;
          bestCand = c;
        }
      }
    }

    // Support = fraction of total candidates that are directionally coherent
    // This measures how "reinforced" the continuation direction is.
    // High support = many strict links agree on continuation.
    // Low support = isolated or ambiguous evidence.
    var support = coherentCount / candidates.length;

    return {
      support: support,
      density: coherentCount,
      bestCandidate: bestCand
    };
  }

  /**
   * Closure pass: detect chains that should be closed (looped) or joined.
   *
   * Two modes:
   *
   * 1. SELF-CLOSURE (same-chain loop): A chain is long enough that its two
   *    endpoints are within closureMaxGapPx of each other, AND the outward
   *    trends from both ends point toward each other (trend agreement).
   *    When accepted, the endpoints are linked, making the chain a loop.
   *
   * 2. CROSS-CHAIN REJOIN: Two chains (not already bridged or part of the
   *    same component) have endpoints within closureMaxGapPx, both trends
   *    point toward each other, and side colors are compatible. When
   *    accepted, the chains are joined via adjacency (merged downstream).
   *
   * Both modes are STRICTLY geometric: no links are created across tokenless
   * voids. The gap must be within the threshold, and geometric agreement
   * (trend dot products > closureTrendMin) is enforced as a hard gate.
   * Color compatibility provides a soft bonus but is NOT a hard rejection.
   *
   * This pass runs AFTER extension and bridging. It catches cases where
   * extension understeered at a transition and left a small closing gap
   * that bridging also missed (bridge is endpoint-pair focused; closure
   * is trend-coherence focused).
   *
   * Modifies adjacency in-place. Returns { closureCount }.
   */
  function _closurePass(chains, loops, adjacency, tokenById, cfg) {
    if (cfg.closureEnabled === false) return { closureCount: 0 };

    var minLen   = cfg.closureMinChainLen != null ? cfg.closureMinChainLen : 6;
    var maxGap   = cfg.closureMaxGapPx    != null ? cfg.closureMaxGapPx   : 24;
    var trendMin = cfg.closureTrendMin    != null ? cfg.closureTrendMin    : 0.40;
    var colorTol = cfg.closureColorTol    != null ? cfg.closureColorTol    : 35;

    // Build set of loop token IDs (chains already detected as loops)
    var loopSet = {};
    for (var li = 0; li < loops.length; li++) {
      var lids = loops[li].ids;
      for (var lj = 0; lj < lids.length; lj++) loopSet[lids[lj]] = true;
    }

    var closureCount = 0;
    var maxGap2 = maxGap * maxGap;

    // Collect all candidate endpoints (first/last token of each qualifying chain)
    // with their outward trend direction.
    var endpoints = [];
    for (var ei = 0; ei < chains.length; ei++) {
      var ch = chains[ei].ids;
      if (ch.length < minLen) continue;
      var firstId = ch[0], lastId = ch[ch.length - 1];
      // Skip if already a confirmed loop
      if (loopSet[firstId] && loopSet[lastId]) continue;

      var firstTok = tokenById[firstId], lastTok = tokenById[lastId];
      if (!firstTok || !lastTok) continue;

      // Use _chainEndTrend for outward trend (consistent with bridging)
      var ft = _chainEndTrend(ch, true,  tokenById);
      var lt = _chainEndTrend(ch, false, tokenById);

      endpoints.push({ tok: firstTok, chainIdx: ei, isFirst: true,  trendX: ft[0], trendY: ft[1] });
      endpoints.push({ tok: lastTok,  chainIdx: ei, isFirst: false, trendX: lt[0], trendY: lt[1] });
    }

    // ── Pass A: Same-chain self-closure ──
    // For each chain, check if its own two endpoints can be linked.
    var closedChains = {};
    for (var pi = 0; pi < endpoints.length; pi++) {
      var epA = endpoints[pi];
      if (!epA.isFirst) continue;          // only check start→end pairs once
      var chainA = chains[epA.chainIdx];
      if (!chainA || chainA.ids.length < minLen) continue;
      if (closedChains[epA.chainIdx]) continue;

      // Find the matching end endpoint of this same chain
      var epEnd = null;
      for (var pj = 0; pj < endpoints.length; pj++) {
        if (pj !== pi && endpoints[pj].chainIdx === epA.chainIdx && !endpoints[pj].isFirst) {
          epEnd = endpoints[pj];
          break;
        }
      }
      if (!epEnd) continue;

      var tokA = epA.tok, tokZ = epEnd.tok;
      var gdx = tokZ.x - tokA.x, gdy = tokZ.y - tokA.y;
      var gap2 = gdx * gdx + gdy * gdy;
      if (gap2 < 4 || gap2 > maxGap2) continue;

      var gap = Math.sqrt(gap2);
      var invGap = 1.0 / gap;
      var gapDirX = gdx * invGap, gapDirY = gdy * invGap;

      // _chainEndTrend(ch, fromStart) returns a unit vector pointing OUTWARD
      // from the endpoint (away from chain interior).
      // gapDir = (Z - A) / |Z - A| points from start A toward end Z.
      //
      // For self-closure: A's outward trend should face TOWARD Z (+gapDir),
      // and Z's outward trend should face TOWARD A (-gapDir).
      var trendDotA = epA.trendX  * gapDirX       + epA.trendY  * gapDirY;
      var trendDotZ = epEnd.trendX * (-gapDirX)   + epEnd.trendY * (-gapDirY);

      if (trendDotA < trendMin || trendDotZ < trendMin) continue;

      // Color: the two endpoints should share similar boundary context
      var llD = _labDist(tokA.leftLab,  tokZ.leftLab);
      var rrD = _labDist(tokA.rightLab, tokZ.rightLab);
      var lrD = _labDist(tokA.leftLab,  tokZ.rightLab);
      var rlD = _labDist(tokA.rightLab, tokZ.leftLab);
      var bestColor = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
      if (bestColor > colorTol * 2) continue; // hard-reject only on very large mismatch

      // Accept: link endpoints
      if (adjacency[tokA.id].indexOf(tokZ.id) < 0) {
        adjacency[tokA.id].push(tokZ.id);
        adjacency[tokZ.id].push(tokA.id);
        closureCount++;
        closedChains[epA.chainIdx] = true;
      }
    }

    // ── Pass B: Cross-chain rejoin ──
    // Find pairs of endpoints from DIFFERENT chains that are close and trend-compatible.
    // This catches cases where extension from two separate chains almost but didn't quite meet.
    for (var pi2 = 0; pi2 < endpoints.length; pi2++) {
      var eA = endpoints[pi2];
      for (var pj2 = pi2 + 1; pj2 < endpoints.length; pj2++) {
        var eB = endpoints[pj2];
        if (eA.chainIdx === eB.chainIdx) continue; // same chain handled in Pass A

        var tA = eA.tok, tB = eB.tok;
        var cgdx = tB.x - tA.x, cgdy = tB.y - tA.y;
        var cgap2 = cgdx * cgdx + cgdy * cgdy;
        if (cgap2 < 4 || cgap2 > maxGap2) continue;

        // Already linked?
        if (adjacency[tA.id].indexOf(tB.id) >= 0) continue;

        var cgap = Math.sqrt(cgap2);
        var cinvGap = 1.0 / cgap;
        var cgapDirX = cgdx * cinvGap, cgapDirY = cgdy * cinvGap;

        // Each endpoint's outward trend should face toward the other endpoint.
        // cgapDir = (eB - eA) / |eB - eA|
        // eA's trend should align with +cgapDir (toward eB).
        // eB's trend should align with -cgapDir (toward eA).
        var ctA = eA.trendX * cgapDirX + eA.trendY * cgapDirY;
        var ctB = eB.trendX * (-cgapDirX) + eB.trendY * (-cgapDirY);

        if (ctA < trendMin || ctB < trendMin) continue;

        // Color compatibility
        var cllD = _labDist(tA.leftLab,  tB.leftLab);
        var crrD = _labDist(tA.rightLab, tB.rightLab);
        var clrD = _labDist(tA.leftLab,  tB.rightLab);
        var crlD = _labDist(tA.rightLab, tB.leftLab);
        var cBestColor = Math.min((cllD + crrD) * 0.5, (clrD + crlD) * 0.5);
        if (cBestColor > colorTol * 2) continue;

        // Gap score (stronger preference for small gaps)
        var gapScore = 1.0 - (cgap / maxGap);
        var trendScore = Math.min(ctA, ctB);
        var colorScore = Math.max(0, 1.0 - cBestColor / colorTol);
        var combined = trendScore * 0.50 + gapScore * 0.35 + colorScore * 0.15;
        if (combined < 0.35) continue;

        // Accept
        adjacency[tA.id].push(tB.id);
        adjacency[tB.id].push(tA.id);
        closureCount++;
      }
    }

    return { closureCount: closureCount };
  }

  /** Compute unit direction vector from token A to token B. */
  function _computeDirectionTo(tokA, tokB) {
    var dx = tokB.x - tokA.x, dy = tokB.y - tokA.y;
    var mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < 0.1) return null;
    return [dx / mag, dy / mag];
  }

  /**
   * Compute the principal axis direction for a set of tokens using PCA.
   *
   * Fits a line through the spatial positions of the tokens and returns
   * a unit direction vector [dx, dy] along the dominant variance axis.
   * This is orientation-agnostic (no sign) — sign-align with a reference
   * direction before using for directional decisions.
   *
   * Unlike _computeChainEndDirection (which requires ordered sequential
   * positions), this function works on any unordered cluster of tokens
   * and is robust to irregular spacing and mild outliers.
   *
   * Returns null if the token cluster is degenerate (< 2 tokens or all
   * coincident).
   */
  function _computeXYTrendDir(tokens) {
    var n = tokens.length;
    if (n < 2) return null;

    // Compute centroid
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += tokens[i].x; cy += tokens[i].y; }
    cx /= n; cy /= n;

    // 2×2 spatial covariance matrix entries
    var sxx = 0, sxy = 0, syy = 0;
    for (var j = 0; j < n; j++) {
      var dx = tokens[j].x - cx, dy = tokens[j].y - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }

    // Dominant eigenvector of [[sxx, sxy], [sxy, syy]].
    // For the larger eigenvalue λ = (sxx+syy)/2 + sqrt(((sxx-syy)/2)² + sxy²),
    // the eigenvector is [sxy, λ - sxx] (unnormalized).
    var trace2 = (sxx + syy) * 0.5;
    var diff2  = (sxx - syy) * 0.5;
    var disc   = Math.sqrt(diff2 * diff2 + sxy * sxy);
    var lambda = trace2 + disc;
    var evX    = sxy;
    var evY    = lambda - sxx;
    var evMag  = Math.sqrt(evX * evX + evY * evY);

    if (evMag < 0.01) {
      // Degenerate: tokens nearly coincident or symmetric; fall back to axis
      return (sxx >= syy) ? [1, 0] : [0, 1];
    }
    return [evX / evMag, evY / evMag];
  }

  /**
   * Measure how well a direction vector fits a set of tokens (PCA explained
   * variance ratio, analogous to R²).
   *
   * Returns 0..1:
   *   1.0 = all tokens perfectly collinear along trendDir
   *   0.5 = tokens have equal variance along and perpendicular to trendDir
   *   0.0 = all variance is perpendicular (trendDir is the minor axis)
   *
   * A value >= 0.65 indicates that the tokens clearly form a line-like
   * arrangement — safe to use for directional blending.
   */
  function _xyTrendConsistency(tokens, trendDir) {
    var n = tokens.length;
    if (n < 2 || !trendDir) return 0;

    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += tokens[i].x; cy += tokens[i].y; }
    cx /= n; cy /= n;

    var varAlong = 0, varTotal = 0;
    for (var j = 0; j < n; j++) {
      var dx = tokens[j].x - cx, dy = tokens[j].y - cy;
      var along = dx * trendDir[0] + dy * trendDir[1];
      varAlong += along * along;
      varTotal += dx * dx + dy * dy;
    }
    return varTotal > 0.01 ? Math.min(1, varAlong / varTotal) : 0;
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
