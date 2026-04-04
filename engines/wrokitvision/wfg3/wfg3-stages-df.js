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
    // Stage D — Boundary-following chain builder (Phase 1 architecture)
    //
    // DESIGN RULE: Chains represent real object boundaries.  Structure
    // dominates over coverage.  Tokens not on clear boundaries remain
    // unlinked rather than being force-merged into chains.
    //
    // The seed-and-trace system uses graphForwardRadius as the trace
    // search radius and graphSideColorGate as the hard boundary-identity
    // gate.  Other graph-first parameters are retained for compatibility
    // but are not actively used by the Phase 1 chain builder.
    graphNeighborRadius:     20,     // retained for compat; not used by trace
    graphForwardRadius:      32,     // was 20; wider Zone 2 to span boundary gaps
    graphForwardDirMin:      0.50,   // tightened from 0.35: blocks 60°+ deviations to prevent cross-boundary jumps
    graphForwardLateralMax:  8,      // was 5; wider lateral for noisy token placement
    graphOrientationTolDeg: 55,
    graphSideDeltaETol:    25,
    chainMinLength:        2,
    linkScoreThreshold:    0.18,     // was 0.25; let more borderline links through

    // Side color hard gate: the PRIMARY cross-boundary safety mechanism.
    // This is the ONE gate that must remain meaningful — it separates
    // tokens on different boundaries.  All other gates can be relaxed.
    graphSideColorGate:    55,

    // Stage D — Pass 1b: Chain endpoint continuation
    chainExtensionMaxDist: 36,      // was 24; wider reach for sparser regions
    chainExtensionDirAlign: 0.30,   // was 0.40; relaxed for curves
    chainExtensionColorTol: 120,
    chainExtensionTrendWindow: 4,
    chainExtensionMaxDirDrift: 0.65, // was 0.55; more drift tolerance for curves

    // Microchaining: use local strict-link populations to reinforce continuation
    microchainEnabled:          true,
    microchainMinCandidates:    2,
    microchainCoherenceThresh:  0.30, // was 0.40; activate with weaker coherence
    microchainDriftRelief:      0.75, // was 0.65; stronger relief
    microchainSupportDecay:     0.92, // was 0.90; slower decay
    microchainSupportFloor:     0.08, // was 0.10; lower floor

    // Lookahead: short-horizon continuation probe (2-4 steps ahead)
    lookaheadEnabled:           true,
    lookaheadMaxDepth:          4,
    lookaheadScoreWeight:       0.30,
    lookaheadDriftRescueDepth:  2,
    lookaheadCoherenceFraction: 0.20, // was 0.25; less coherence penalty

    // Stage D: Pass-2 Bridging (token-native, geometry-first)
    bridgeEnabled:          true,
    bridgeMaxGapPx:         36,      // was 24; wider to bridge more gaps
    bridgeDirAgreementMin:  0.35,    // was 0.50; relaxed for curves/corners
    bridgeSideDeltaETol:    35,
    bridgeMinCombinedScore: 0.22,    // was 0.30; accept more bridges

    // Stage D: Structural outlier pruning
    //
    // Pruning is now CONSERVATIVE — salience scoring handles priority,
    // not pruning.  Only remove tokens that are genuinely structural
    // misfits, not "borderline" tokens.
    outlierPruneEnabled:    true,
    outlierDirDeviationMax: 0.70,    // was 0.55; very lenient
    outlierMinNeighborSupport: 2,
    outlierPruneTinyComponents: true,
    outlierTinyComponentSize: 1,

    // Stage D: Multi-token XY trend reasoning
    xyTrendEnabled:          true,
    xyTrendWindowSize:       10,
    xyTrendMinTokens:        4,
    xyTrendBlendWeight:      0.35,
    xyTrendConsistencyMin:   0.50,   // was 0.55; activate sooner

    // Stage D: Lookahead upgrade
    lookaheadBeamWidth:      3,
    lookaheadDensityRadius:  16,     // was 14; slightly wider
    lookaheadDensityWeight:  0.15,

    // Stage D: Closure pass
    closureEnabled:          true,
    closureMinChainLen:      3,      // was 4; allow shorter chains to close
    closureMaxGapPx:         40,     // was 32; wider closure reach
    closureTrendMin:         0.25,   // was 0.35; more lenient trend agreement
    closureColorTol:         45,     // was 40; slightly wider

    // Stage D: Phase 4 — Boundary contour consolidation
    consolidationProximityPx: 50,    // max distance between any two tokens in
                                      // compatible chains to consider them same-boundary

    // Stage D: Multi-pass refinement
    maxRefinementPasses:     3,      // was 2; one more pass to reach more tokens

    // Stage D: Branch anchor recovery
    branchAnchorEnabled:     true,

    // Stage D: Residual recovery — reclaim orphaned tokens after refinement.
    // Instead of permanently discarding tokens that fail initial linking,
    // a recovery pass searches for compatible chain attachment points using
    // relaxed gates. This preserves structural information that strict
    // Pass 1 gates would otherwise lose permanently.
    residualRecoveryEnabled:    true,
    residualRecoveryRadius:     40,    // was 28; match rescue radius
    residualRecoveryDirMin:     0.10,  // was 0.20; very relaxed for corners
    residualRecoveryMaxPasses:  3,     // was 2; more attempts

    // Stage D: Rescue linking — create seed chains from orphaned tokens.
    // After Pass 1's strict gates, some regions may have ZERO chains
    // (all tokens orphaned).  Subsequent passes (extension, bridge,
    // closure, recovery) all require existing chains to operate on —
    // they cannot create chains from scratch.
    //
    // Rescue linking fixes this: it runs BEFORE refinement, linking
    // orphaned tokens (degree 0) to other nearby orphans using relaxed
    // gates while maintaining the side-color hard gate to prevent
    // cross-boundary contamination.  This creates seed chains in
    // previously dead regions, which subsequent passes then grow.
    rescueLinkingEnabled:       true,
    rescueLinkingRadius:        48,    // was 40; even wider for large gaps
    rescueLinkingDirMin:        0.08,  // was 0.12; nearly omnidirectional for corners
    rescueLinkingScoreMin:      0.10,  // was 0.15; accept weaker links
    rescueLinkingMaxPasses:     4,     // was 3; more passes to chain-propagate

    // Stage D: Token salience scoring.
    // After chain assembly, every token receives a structural salience
    // score (0..1) reflecting its contribution to coherent boundary
    // structure.  High-salience tokens (long chains, good coherence,
    // enclosure contributors) are protected from pruning.  Low-salience
    // tokens (isolated, noisy, interior clutter) can be demoted.
    salienceEnabled:            true,
    saliencePruneFloor:         0.12,  // tokens below this AND unattached → prunable

    // Stage D: Meso-scale tangent refinement.
    // DESIGN RULE: Token tangents from Stage C are computed at 1-3px Sobel
    // scale — far too noisy for contour-scale linking.  Before ANY linking,
    // replace each token's tangent with a PCA-derived contour direction
    // estimated from the spatial arrangement of nearby same-boundary tokens.
    // This operates at token-spacing scale (~8-15px) where contours are
    // visible, not at pixel-noise scale.
    mesoTangentEnabled:         true,
    mesoTangentRadius:          24,     // neighborhood search radius (px)
    mesoTangentMinNeighbors:    3,      // need ≥3 neighbors for meaningful PCA
    mesoTangentSideColorGate:   55,     // same as main side-color gate
    mesoTangentEigenRatioMin:   1.5,    // λ1/λ2 must show clear linear structure

    // Stage D: Coverage enforcement (DISABLED in Phase 1).
    // Phase 1 architecture prioritizes structure over coverage.
    // Tokens not on clear boundaries remain unlinked.
    minTokenCoverageRatio:      0.0,  // was 0.95; disabled for boundary-following

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

    // ── Phase 0 Diagnostics: track rejection reasons throughout the pipeline ──
    var _diag = {
      totalTokens: tokens.length,
      pass1_linksEvaluated: 0,
      pass1_linksAccepted: 0,
      pass1_rejectedPerpendicular: 0,
      pass1_rejectedZone2Dir: 0,
      pass1_rejectedZone2Lateral: 0,
      pass1_rejectedZone2ConnAlign: 0,
      pass1_rejectedSideColorGate: 0,
      pass1_rejectedLinkScore: 0,
      pass1_componentsFound: 0,
      pass1_tokensInComponents: 0,
      pass1_tokensOrphaned: 0,
      extension_chainsExtended: 0,
      extension_totalStepsAdded: 0,
      extension_driftKills: 0,
      extension_noCandidates: 0,
      extension_driftRescues: 0,
      outlier_prunedCount: 0,
      rescue_linksCreated: 0,
      rescue_chainsSeeded: 0,
      rescue_passesRun: 0,
      recovery_tokensRecovered: 0,
      recovery_tokensUnrecovered: 0,
      recovery_passesRun: 0,
      meso_refined: 0,
      meso_skippedFewNeighbors: 0,
      meso_skippedIsotropic: 0,
      meso_totalTokens: 0,
      finalChainCount: 0,
      finalLoopCount: 0,
      finalTokensInChains: 0
    };

    // Derive image dimensions from token positions (needed only for chain mask rasterization)
    var W = cfg.imageWidth || 0, H = cfg.imageHeight || 0;
    for (var di = 0; di < tokens.length; di++) {
      if (tokens[di].x >= W) W = tokens[di].x + 1;
      if (tokens[di].y >= H) H = tokens[di].y + 1;
    }
    // ── Meso-scale tangent refinement ──
    // Replace noisy 1-pixel Sobel tangents with PCA-derived contour directions
    // BEFORE any linking.  This is the single most impactful preprocessing step:
    // it transforms tangent comparison from "do two random pixel-noise vectors agree?"
    // to "do two tokens lie along the same contour direction at visible scale?"
    if (cfg.mesoTangentEnabled !== false) {
      _refineTangentsMesoScale(tokens, cfg, _diag);
    }

    /* ================================================================
     *  BOUNDARY-FOLLOWING CHAIN BUILDER (Phase 1 architecture)
     *
     *  Instead of building an adjacency graph → finding connected
     *  components → greedy ordering, we directly trace boundary-following
     *  chains from seed tokens.
     *
     *  Each chain is built by:
     *    1. Picking a seed token (highest confidence unused token)
     *    2. Tracing forward: at each step, scoring candidates by how well
     *       they continue the current boundary path (direction continuity,
     *       tangent alignment, side-color consistency, spacing regularity)
     *    3. Tracing backward from seed using the same logic
     *    4. The result is an ordered chain that follows a real boundary
     *
     *  Chain-level state is tracked throughout:
     *    - Running direction (updated each step)
     *    - Side identity (left/right LAB, checked for consistency)
     *    - Step spacing (for regularity scoring)
     *
     *  The adjacency dict is built FROM the traced chains (consecutive
     *  tokens in a chain become adjacent), so the downstream pipeline
     *  (extension, bridging, closure, recovery) still works.
     * ================================================================ */

    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    var traceRadius = cfg.graphForwardRadius || 32;
    var traceR2 = traceRadius * traceRadius;
    var traceDirMin = cfg.graphForwardDirMin || 0.35;

    // Token lookup
    var tokenById = {};
    for (var oi = 0; oi < tokens.length; oi++) tokenById[tokens[oi].id] = tokens[oi];

    // Spatial index for tracing
    var cellSize = traceRadius + 1;
    var grid = {};
    for (var ti = 0; ti < tokens.length; ti++) {
      var t = tokens[ti];
      var gx = (t.x / cellSize) | 0;
      var gy = (t.y / cellSize) | 0;
      var key = gx + ',' + gy;
      if (!grid[key]) grid[key] = [];
      grid[key].push(t);
    }

    // Trace all chains
    var traceResult = _seedAndTrace(tokens, tokenById, grid, cellSize, cfg, _diag);
    var chains = traceResult.chains;
    var loops = traceResult.loops;

    // Build adjacency dict from traced chains.
    // Consecutive tokens in each chain become adjacent — this is the
    // structural adjacency that downstream passes (extension, bridge,
    // closure) operate on.
    var adjacency = {};
    for (var ai = 0; ai < tokens.length; ai++) adjacency[tokens[ai].id] = [];

    for (var ki = 0; ki < chains.length; ki++) {
      var chIds = chains[ki].ids;
      for (var kj = 0; kj < chIds.length - 1; kj++) {
        var idA = chIds[kj], idB = chIds[kj + 1];
        adjacency[idA].push(idB);
        adjacency[idB].push(idA);
      }
      // Close loop adjacency
      if (chains[ki]._isLoop && chIds.length >= 3) {
        var loopA = chIds[0], loopB = chIds[chIds.length - 1];
        var alreadyLinked = false;
        for (var lci = 0; lci < adjacency[loopA].length; lci++) {
          if (adjacency[loopA][lci] === loopB) { alreadyLinked = true; break; }
        }
        if (!alreadyLinked) {
          adjacency[loopA].push(loopB);
          adjacency[loopB].push(loopA);
        }
      }
    }

    // Diagnostics
    _diag.pass1_componentsFound = chains.length;
    var _tracedCount = 0;
    for (var _tci = 0; _tci < chains.length; _tci++) _tracedCount += chains[_tci].ids.length;
    _diag.pass1_tokensInComponents = _tracedCount;
    _diag.pass1_tokensOrphaned = tokens.length - _tracedCount;

    // Strip internal _isLoop flag from chain objects (not part of contract)
    for (var _si = 0; _si < chains.length; _si++) delete chains[_si]._isLoop;

    /* ================================================================
     *  PHASE 2: BOUNDARY-AWARE STRUCTURE ASSEMBLY
     *
     *  Three mechanisms, run in sequence:
     *
     *  1. Boundary-aware extension: grow chain endpoints using the same
     *     trace logic as Phase 1 (direction, side identity, spacing).
     *     Properly prepends to start / appends to end.
     *
     *  2. Structural merge: merge chain pairs that are clearly on the
     *     same boundary (matching endpoint direction, side pattern,
     *     spacing).  This replaces the old proximity-based bridging.
     *
     *  3. Noise classification: orphan tokens are tagged (not force-linked).
     *
     *  No graph-first chain rebuilds.  Chain order is always maintained.
     * ================================================================ */

    var bridgeEdgeList = [];
    var bridgesEvaluated = 0;
    var bridgesAccepted = 0;

    // Track which tokens are in chains (for extension to avoid)
    var claimed = {};
    for (var _clI = 0; _clI < chains.length; _clI++) {
      var _clIds = chains[_clI].ids;
      for (var _clJ = 0; _clJ < _clIds.length; _clJ++) claimed[_clIds[_clJ]] = true;
    }

    // ── Step 1: Boundary-aware extension ──
    // Grow each chain's endpoints using the same trace-style scoring
    // as Phase 1 (direction continuity + tangent + side identity + spacing).
    // Longer chains extend first to claim tokens before shorter fragments.
    var maxExtPasses = cfg.maxRefinementPasses || 3;
    for (var _extPass = 0; _extPass < maxExtPasses; _extPass++) {
      var _extChanged = 0;

      // Sort by length descending — strongest boundaries extend first
      chains.sort(function(a, b) { return b.ids.length - a.ids.length; });

      for (var _ei = 0; _ei < chains.length; _ei++) {
        var _ech = chains[_ei];
        if (_ech.ids.length < 2) continue;

        // Extend from end (append)
        var endAdded = _boundaryExtend(_ech.ids, false, tokenById, grid, cellSize,
                                        traceRadius, traceR2, sideColorGate, traceDirMin,
                                        claimed, adjacency);
        // Extend from start (prepend)
        var startAdded = _boundaryExtend(_ech.ids, true, tokenById, grid, cellSize,
                                          traceRadius, traceR2, sideColorGate, traceDirMin,
                                          claimed, adjacency);
        _extChanged += endAdded + startAdded;
        _diag.extension_totalStepsAdded += endAdded + startAdded;
        if (endAdded + startAdded > 0) _diag.extension_chainsExtended++;
      }

      if (_extChanged === 0) break;
    }

    // ── Step 2: Structural merge ──
    // Merge chain pairs whose endpoints align in direction, side pattern,
    // and spacing.  This replaces the old proximity-based bridging.
    var mergeResult = _structuralMerge(chains, loops, adjacency, tokenById, claimed, cfg);
    chains = mergeResult.chains;
    loops = mergeResult.loops;
    bridgesAccepted = mergeResult.mergeCount;
    bridgeEdgeList = mergeResult.mergeEdgeList;

    // Update diagnostics
    _diag.extension_chainsExtended = _diag.extension_chainsExtended || 0;
    _diag.extension_totalStepsAdded = _diag.extension_totalStepsAdded || 0;

    /* ================================================================
     *  PHASE 4: BOUNDARY CONTOUR CONSOLIDATION
     *
     *  The tracer (Phase 1) seeds by confidence and traces locally.
     *  This produces many fragments per object boundary — the tracer
     *  terminates at corners, curvature limits, or when it runs into
     *  tokens already claimed by a higher-confidence seed.
     *
     *  Structural merge (Phase 2) reconnects some fragments, but only
     *  by matching endpoints locally.  It cannot unify 30+ fragments
     *  scattered around the same object boundary.
     *
     *  Contour consolidation operates at WHOLE-BOUNDARY scale:
     *
     *    1. Compute per-chain boundary signature (avg left/right LAB)
     *    2. Group chains by side-color identity (transitive closure)
     *    3. Within each color group, find spatially connected components
     *       using any-token-to-any-token proximity — this naturally
     *       separates distinct objects that share the same colors
     *    4. Within each spatial component, order fragments by greedy
     *       nearest-endpoint walk and concatenate into one chain
     *    5. Re-detect loops on the unified chains
     *
     *  This reduces many-chains-per-object toward one-chain-per-boundary,
     *  even across corners and curves.
     * ================================================================ */

    var consolResult = _consolidateBoundaryContours(chains, loops, adjacency, tokenById, cfg);
    chains = consolResult.chains;
    loops = consolResult.loops;

    // Noise classification runs AFTER consolidation so it classifies
    // tokens that are truly orphans (not just pre-consolidation fragments).
    var tokenClassification = _classifyOrphanTokens(tokens, chains, tokenById, grid, cellSize, cfg);

    /* ================================================================
     *  PHASE 3: CLOSURE + STRUCTURE DOMINANCE
     *
     *  1. Boundary-aware closure: chains prefer to close themselves
     *     when endpoints converge and curvature supports it.
     *
     *  2. Jump detection: identify and split chains at anomalous jumps
     *     (large distance or sharp direction breaks mid-chain).
     *
     *  3. Structure dominance: closed loops and spatially coherent
     *     enclosures are prioritized.  Short fragments between parallel
     *     boundaries are demoted.  Interior noise chains are removed.
     *
     *  4. Boundary coherence salience: replaces the old chain-length
     *     based salience with a metric based on side consistency,
     *     direction smoothness, and enclosure contribution.
     * ================================================================ */

    // ── Step 1: Boundary-aware closure ──
    var closureResult = _boundaryAwareClosure(chains, loops, adjacency, tokenById, cfg);
    chains = closureResult.chains;
    loops = closureResult.loops;

    // ── Step 2: Jump detection — split chains at anomalous discontinuities ──
    var jumpResult = _detectAndSplitJumps(chains, loops, adjacency, tokenById, cfg);
    chains = jumpResult.chains;
    loops = jumpResult.loops;

    // ── Step 3: Structure dominance — remove short cross-boundary fragments ──
    var domResult = _applyStructureDominance(chains, loops, adjacency, tokenById, cfg);
    chains = domResult.chains;
    loops = domResult.loops;

    // ── Step 4: Boundary coherence salience ──
    var tokenSalience = null;
    if (cfg.salienceEnabled !== false) {
      tokenSalience = _computeBoundaryCoherenceSalience(tokens, chains, adjacency, tokenById, cfg);
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

    // ── Final diagnostics ──
    _diag.finalChainCount = chains.length;
    _diag.finalLoopCount = loops.length;
    var _diagTokSet = {};
    for (var _dci = 0; _dci < chains.length; _dci++) {
      var _dch = chains[_dci].ids;
      for (var _dcj = 0; _dcj < _dch.length; _dcj++) _diagTokSet[_dch[_dcj]] = true;
    }
    for (var _dk in _diagTokSet) _diag.finalTokensInChains++;

    return {
      kind: 'wfg3-boundary-graph',
      adjacency: adjacency,
      chains: chains,
      loops: loops,
      chainMask: chainMask,
      bridgeEdgeList: bridgeEdgeList,
      bridgesEvaluated: bridgesEvaluated,
      bridgesAccepted: bridgesAccepted,
      tokenSalience: tokenSalience,   // { tokenId → 0..1 } structural importance
      tokenClassification: tokenClassification, // { tokenId → 'boundary'|'interior'|'weak'|'unresolved' }
      diagnostics: _diag
    };
  }

  /* ── LAB distance helper ── */

  function _labDist(lab1, lab2) {
    var dL = lab1[0] - lab2[0];
    var da = lab1[1] - lab2[1];
    var db = lab1[2] - lab2[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Meso-scale tangent refinement
   *
   *  Problem: Stage C computes tangents from single-pixel Sobel gradients
   *  (1-3px scale).  These are too noisy for contour-scale linking — two
   *  tokens on the same smooth boundary 15px apart may have wildly
   *  different micro-tangents, causing Pass 1 to reject the link.
   *
   *  Solution: Before any linking, for each token find nearby tokens on
   *  the same boundary (side-color gate), fit PCA on their spatial (x,y)
   *  positions, and replace the token tangent with the PCA principal axis.
   *  This estimates contour direction at token-spacing scale (~8-15px)
   *  where the contour is actually visible as a coherent structure.
   *
   *  The side-color gate ensures we only aggregate tokens from the SAME
   *  boundary, preventing cross-boundary contamination from biasing the
   *  PCA direction.
   * ──────────────────────────────────────────────────────────────────── */
  function _refineTangentsMesoScale(tokens, cfg, _diag) {
    var radius    = cfg.mesoTangentRadius || 24;
    var minNeigh  = cfg.mesoTangentMinNeighbors || 3;
    var colorGate = cfg.mesoTangentSideColorGate != null ? cfg.mesoTangentSideColorGate : 55;
    var eigenMin  = cfg.mesoTangentEigenRatioMin || 1.5;

    // Build spatial grid for neighbor lookup
    var cellSize = radius + 1;
    var grid = {};
    for (var gi = 0; gi < tokens.length; gi++) {
      var gt = tokens[gi];
      var gx = (gt.x / cellSize) | 0;
      var gy = (gt.y / cellSize) | 0;
      var gk = gx + ',' + gy;
      if (!grid[gk]) grid[gk] = [];
      grid[gk].push(gt);
    }

    var refined = 0, skippedFewNeighbors = 0, skippedIsotropic = 0;
    var radius2 = radius * radius;

    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      var cx = (tok.x / cellSize) | 0;
      var cy = (tok.y / cellSize) | 0;

      // Gather same-boundary neighbors within radius
      var neighbors = [];
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nk = (cx + dx) + ',' + (cy + dy);
          var cell = grid[nk];
          if (!cell) continue;
          for (var ni = 0; ni < cell.length; ni++) {
            var nb = cell[ni];
            if (nb.id === tok.id) continue;
            var ddx = nb.x - tok.x, ddy = nb.y - tok.y;
            if (ddx * ddx + ddy * ddy > radius2) continue;

            // Side-color gate: same boundary check
            var llD = _labDist(tok.leftLab, nb.leftLab);
            var rrD = _labDist(tok.rightLab, nb.rightLab);
            var lrD = _labDist(tok.leftLab, nb.rightLab);
            var rlD = _labDist(tok.rightLab, nb.leftLab);
            var sameD = (llD + rrD) * 0.5;
            var flipD = (lrD + rlD) * 0.5;
            if (Math.min(sameD, flipD) > colorGate) continue;

            neighbors.push(nb);
          }
        }
      }

      if (neighbors.length < minNeigh) {
        skippedFewNeighbors++;
        continue; // keep original Sobel tangent
      }

      // PCA on spatial positions of token + its neighbors
      // Compute centroid
      var sumX = tok.x, sumY = tok.y;
      var n = neighbors.length + 1; // include self
      for (var pi = 0; pi < neighbors.length; pi++) {
        sumX += neighbors[pi].x;
        sumY += neighbors[pi].y;
      }
      var meanX = sumX / n, meanY = sumY / n;

      // Compute 2×2 covariance matrix
      var cxx = 0, cxy = 0, cyy = 0;
      var rx = tok.x - meanX, ry = tok.y - meanY;
      cxx += rx * rx; cxy += rx * ry; cyy += ry * ry;
      for (var qi = 0; qi < neighbors.length; qi++) {
        rx = neighbors[qi].x - meanX;
        ry = neighbors[qi].y - meanY;
        cxx += rx * rx; cxy += rx * ry; cyy += ry * ry;
      }
      cxx /= n; cxy /= n; cyy /= n;

      // Analytical eigendecomposition of 2×2 symmetric matrix
      // [[cxx, cxy], [cxy, cyy]]
      var trace = cxx + cyy;
      var det = cxx * cyy - cxy * cxy;
      var disc = trace * trace - 4 * det;
      if (disc < 0) disc = 0;
      var sqrtDisc = Math.sqrt(disc);
      var lambda1 = (trace + sqrtDisc) * 0.5; // larger eigenvalue
      var lambda2 = (trace - sqrtDisc) * 0.5; // smaller eigenvalue

      // Check eigenratio: is there clear linear structure?
      // If points are clustered isotropically, PCA direction is meaningless.
      if (lambda2 < 1e-8) {
        // Degenerate: nearly all variance in one direction — good, use it
      } else if (lambda1 / lambda2 < eigenMin) {
        skippedIsotropic++;
        continue; // cluster is too round, keep original tangent
      }

      // Principal eigenvector (for lambda1)
      var evx, evy;
      if (Math.abs(cxy) > 1e-10) {
        evx = lambda1 - cyy;
        evy = cxy;
      } else if (cxx >= cyy) {
        evx = 1; evy = 0;
      } else {
        evx = 0; evy = 1;
      }
      var evMag = Math.sqrt(evx * evx + evy * evy);
      if (evMag < 1e-10) continue;
      evx /= evMag; evy /= evMag;

      // Sign-align with original tangent so direction sense is preserved
      var origDot = evx * tok.tangentX + evy * tok.tangentY;
      if (origDot < 0) { evx = -evx; evy = -evy; }

      // Derive new normal perpendicular to new tangent.
      // Original convention: tx = -ny, ty = nx  →  nx = ty, ny = -tx
      // New normal candidate from same convention:
      var newNx = evy, newNy = -evx;
      // Ensure normal preserves left/right side assignment by checking
      // it points roughly the same direction as the original normal
      var oldNx = tok.normalX, oldNy = tok.normalY;
      if (newNx * oldNx + newNy * oldNy < 0) {
        newNx = -newNx; newNy = -newNy;
      }

      tok.tangentX = evx;
      tok.tangentY = evy;
      tok.normalX = newNx;
      tok.normalY = newNy;

      refined++;
    }

    if (_diag) {
      _diag.meso_refined = refined;
      _diag.meso_skippedFewNeighbors = skippedFewNeighbors;
      _diag.meso_skippedIsotropic = skippedIsotropic;
      _diag.meso_totalTokens = tokens.length;
    }

    return refined;
  }

  /* ─────────────��───────────────────────��────────────────────────────
   *  Seed-and-trace boundary-following chain builder
   *
   *  Replaces the graph→components→ordering pipeline with direct
   *  boundary tracing.  Each chain is constructed as an ordered walk
   *  along a boundary, maintaining chain-level state:
   *    - running direction (smoothed over recent steps)
   *    - side identity (left/right LAB of the boundary)
   *    - step spacing (for regularity)
   *
   *  Seeds are chosen by descending confidence — the strongest boundary
   *  evidence initiates chains first, claiming tokens before weaker
   *  seeds can.  This ensures dominant structure emerges cleanly.
   *
   *  A chain terminates when no candidate scores above the acceptance
   *  threshold, meaning the boundary has ended, become ambiguous, or
   *  crossed into another structure.
   * ───────────────────────────────────��──────────────────────────────── */
  function _seedAndTrace(tokens, tokenById, grid, cellSize, cfg, _diag) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    var traceRadius = cfg.graphForwardRadius || 32;
    var traceDirMin = cfg.graphForwardDirMin || 0.35;
    var chainMinLen = cfg.chainMinLength || 2;

    // Set of token IDs already claimed by a chain
    var claimed = {};

    // Sort tokens by confidence descending — best evidence seeds first
    var seedOrder = tokens.slice().sort(function(a, b) {
      return b.confidence - a.confidence;
    });

    var chains = [];
    var loops = [];
    var traceR2 = traceRadius * traceRadius;

    for (var si = 0; si < seedOrder.length; si++) {
      var seed = seedOrder[si];
      if (claimed[seed.id]) continue;

      // ── Trace forward from seed ──
      var forward = _traceDirection(seed, tokenById, grid, cellSize, traceRadius, traceR2,
                                     sideColorGate, traceDirMin, claimed, false);

      // ── Trace backward from seed ──
      var backward = _traceDirection(seed, tokenById, grid, cellSize, traceRadius, traceR2,
                                      sideColorGate, traceDirMin, claimed, true);

      // Assemble chain: backward (reversed) + seed + forward
      backward.reverse();
      var chainIds = [];
      for (var bi = 0; bi < backward.length; bi++) chainIds.push(backward[bi]);
      chainIds.push(seed.id);
      for (var fi = 0; fi < forward.length; fi++) chainIds.push(forward[fi]);

      if (chainIds.length < chainMinLen) continue;

      // Claim all tokens in this chain
      for (var ci2 = 0; ci2 < chainIds.length; ci2++) claimed[chainIds[ci2]] = true;

      // Check for loop: if first and last tokens are close and direction-compatible
      var isLoop = false;
      if (chainIds.length >= 6) {
        var firstTok = tokenById[chainIds[0]];
        var lastTok = tokenById[chainIds[chainIds.length - 1]];
        if (firstTok && lastTok) {
          var ldx = firstTok.x - lastTok.x, ldy = firstTok.y - lastTok.y;
          var loopDist2 = ldx * ldx + ldy * ldy;
          // Close enough to form a loop (within 1.5x typical step spacing)
          if (loopDist2 < traceRadius * traceRadius) {
            // Check direction consistency: chain-end directions should point toward each other
            var lastDir = _estimateChainEndDir(chainIds, false, tokenById);
            var firstDir = _estimateChainEndDir(chainIds, true, tokenById);
            if (lastDir && firstDir) {
              var loopDist = Math.sqrt(loopDist2);
              if (loopDist > 0.5) {
                var gapX = ldx / loopDist, gapY = ldy / loopDist;
                // Last end should point toward first (positive dot with gap direction)
                var lastToFirst = lastDir[0] * gapX + lastDir[1] * gapY;
                // First end should point away from last (negative dot) — but since
                // firstDir points outward from start, we check it points toward last
                var firstToLast = firstDir[0] * (-gapX) + firstDir[1] * (-gapY);
                if (lastToFirst > 0.35 && firstToLast > 0.35) {
                  // Side color consistency between endpoints
                  var llD = _labDist(firstTok.leftLab, lastTok.leftLab);
                  var rrD = _labDist(firstTok.rightLab, lastTok.rightLab);
                  var lrD = _labDist(firstTok.leftLab, lastTok.rightLab);
                  var rlD = _labDist(firstTok.rightLab, lastTok.leftLab);
                  var bestCD = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
                  if (bestCD <= sideColorGate) {
                    isLoop = true;
                  }
                }
              } else {
                // Endpoints are nearly coincident — definitely a loop
                isLoop = true;
              }
            }
          }
        }
      }

      var chainObj = { ids: chainIds, ordered: true, _isLoop: isLoop };
      chains.push(chainObj);
      if (isLoop) loops.push({ ids: chainIds });
    }

    return { chains: chains, loops: loops };
  }

  /**
   * Trace a boundary chain in one direction from a starting token.
   *
   * At each step, candidates within traceRadius are scored by:
   *   1. Direction continuity (40%): does stepping here continue the chain's heading?
   *   2. Tangent alignment (25%): does the candidate's tangent match the boundary direction?
   *   3. Side-color consistency (20%): does the candidate have the same left/right colors?
   *   4. Spacing regularity (15%): is the step distance consistent with previous steps?
   *
   * The side-color hard gate is always enforced (non-negotiable).
   *
   * Returns array of token IDs (not including the start token).
   */
  function _traceDirection(startTok, tokenById, grid, cellSize, traceRadius, traceR2,
                            sideColorGate, dirMin, claimed, isBackward) {
    var result = [];
    var curTok = startTok;

    // Chain state: running direction (initialized from token tangent)
    var dirX = isBackward ? -curTok.tangentX : curTok.tangentX;
    var dirY = isBackward ? -curTok.tangentY : curTok.tangentY;
    var hasDir = true;

    // Chain state: side identity (left/right LAB running average)
    var sideLeftL = curTok.leftLab[0], sideLeftA = curTok.leftLab[1], sideLeftB = curTok.leftLab[2];
    var sideRightL = curTok.rightLab[0], sideRightA = curTok.rightLab[1], sideRightB = curTok.rightLab[2];

    // Chain state: step spacing (running average)
    var avgSpacing = 0;
    var spacingCount = 0;

    var maxSteps = 500; // safety limit
    var localClaimed = {};
    localClaimed[startTok.id] = true;

    for (var step = 0; step < maxSteps; step++) {
      var cgx = (curTok.x / cellSize) | 0;
      var cgy = (curTok.y / cellSize) | 0;

      var bestId = -1;
      var bestScore = -Infinity;
      var bestIsFlipped = false;

      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nk = (cgx + dx) + ',' + (cgy + dy);
          var cell = grid[nk];
          if (!cell) continue;

          for (var ci = 0; ci < cell.length; ci++) {
            var cand = cell[ci];
            if (cand.id === curTok.id) continue;
            if (claimed[cand.id] || localClaimed[cand.id]) continue;

            var ddx = cand.x - curTok.x, ddy = cand.y - curTok.y;
            var dist2 = ddx * ddx + ddy * ddy;
            if (dist2 > traceR2 || dist2 < 1) continue;
            var dist = Math.sqrt(dist2);

            // ── Side-color HARD GATE ──
            var llD = _labDist(curTok.leftLab, cand.leftLab);
            var rrD = _labDist(curTok.rightLab, cand.rightLab);
            var lrD = _labDist(curTok.leftLab, cand.rightLab);
            var rlD = _labDist(curTok.rightLab, cand.leftLab);
            var sameSideDist = (llD + rrD) * 0.5;
            var flipSideDist = (lrD + rlD) * 0.5;
            var bestColorDist = Math.min(sameSideDist, flipSideDist);
            if (bestColorDist > sideColorGate) continue;

            // ── Component 1: Direction continuity (40%) ──
            var connDirX = ddx / dist, connDirY = ddy / dist;
            var dirContinuity;
            if (hasDir) {
              // How well does this step continue the chain's heading?
              dirContinuity = connDirX * dirX + connDirY * dirY;
              // Reject candidates that go backward
              if (dirContinuity < dirMin) continue;

              // Lateral distance guard: reject candidates that are mostly
              // sideways relative to the chain direction.  This prevents
              // cross-boundary jumps between parallel boundaries.
              var lateralDist = Math.abs(ddx * (-dirY) + ddy * dirX);
              if (lateralDist > dist * 0.65) continue; // >~40° lateral offset

              // Normalize to [0, 1] where 1 = perfectly forward
              dirContinuity = (dirContinuity + 1.0) * 0.5;
            } else {
              // No direction yet — use tangent alignment for initial heading
              dirContinuity = Math.abs(curTok.tangentX * connDirX + curTok.tangentY * connDirY);
            }

            // ── Component 2: Tangent alignment (25%) ──
            var tangDot = Math.abs(curTok.tangentX * cand.tangentX + curTok.tangentY * cand.tangentY);

            // ── Component 3: Side-color consistency with chain identity (20%) ──
            // Compare candidate's side colors to the chain's running side identity
            var chainSideLeft = [sideLeftL, sideLeftA, sideLeftB];
            var chainSideRight = [sideRightL, sideRightA, sideRightB];
            var sameChainDist = (_labDist(chainSideLeft, cand.leftLab) +
                                _labDist(chainSideRight, cand.rightLab)) * 0.5;
            var flipChainDist = (_labDist(chainSideLeft, cand.rightLab) +
                                _labDist(chainSideRight, cand.leftLab)) * 0.5;
            var chainColorDist = Math.min(sameChainDist, flipChainDist);
            var colorScore = Math.max(0, 1.0 - chainColorDist / sideColorGate);

            // ── Component 4: Spacing regularity (15%) ──
            var spacingScore;
            if (spacingCount >= 2 && avgSpacing > 1) {
              // Prefer candidates at similar spacing to what we've been doing
              var spacingRatio = dist / avgSpacing;
              // Score peaks at 1.0 when spacing matches, drops off for 2x or 0.5x
              spacingScore = Math.max(0, 1.0 - Math.abs(spacingRatio - 1.0));
            } else {
              // Not enough history — give moderate score, prefer closer
              spacingScore = Math.max(0, 1.0 - dist / traceRadius);
            }

            var score = 0.40 * dirContinuity + 0.25 * tangDot + 0.20 * colorScore + 0.15 * spacingScore;

            if (score > bestScore) {
              bestScore = score;
              bestId = cand.id;
              // Save flip state for side-identity update
              bestIsFlipped = flipChainDist < sameChainDist;
            }
          }
        }
      }

      // No acceptable candidate found — chain terminates
      if (bestId < 0) break;

      var bestTok = tokenById[bestId];
      result.push(bestId);
      localClaimed[bestId] = true;

      // Update chain direction: blend new step direction with running direction
      var stepDx = bestTok.x - curTok.x, stepDy = bestTok.y - curTok.y;
      var stepDist = Math.sqrt(stepDx * stepDx + stepDy * stepDy);
      if (stepDist > 0.5) {
        var newDirX = stepDx / stepDist, newDirY = stepDy / stepDist;
        if (hasDir) {
          // Exponential moving average: 60% new, 40% old for responsiveness to curves
          dirX = 0.60 * newDirX + 0.40 * dirX;
          dirY = 0.60 * newDirY + 0.40 * dirY;
          var dirMag = Math.sqrt(dirX * dirX + dirY * dirY);
          if (dirMag > 0.01) { dirX /= dirMag; dirY /= dirMag; }
        } else {
          dirX = newDirX;
          dirY = newDirY;
          hasDir = true;
        }
      }

      // Update side identity: blend with new token (EMA, α = 0.3)
      // Use the flip state saved alongside the best candidate selection
      var isFlipped = bestIsFlipped;
      var candLL, candLA, candLB, candRL, candRA, candRB;
      if (isFlipped) {
        candLL = bestTok.rightLab[0]; candLA = bestTok.rightLab[1]; candLB = bestTok.rightLab[2];
        candRL = bestTok.leftLab[0]; candRA = bestTok.leftLab[1]; candRB = bestTok.leftLab[2];
      } else {
        candLL = bestTok.leftLab[0]; candLA = bestTok.leftLab[1]; candLB = bestTok.leftLab[2];
        candRL = bestTok.rightLab[0]; candRA = bestTok.rightLab[1]; candRB = bestTok.rightLab[2];
      }
      // Side-identity EMA with α = 0.15 (slow drift preserves boundary identity)
      sideLeftL = 0.85 * sideLeftL + 0.15 * candLL;
      sideLeftA = 0.85 * sideLeftA + 0.15 * candLA;
      sideLeftB = 0.85 * sideLeftB + 0.15 * candLB;
      sideRightL = 0.85 * sideRightL + 0.15 * candRL;
      sideRightA = 0.85 * sideRightA + 0.15 * candRA;
      sideRightB = 0.85 * sideRightB + 0.15 * candRB;

      // Update spacing
      if (stepDist > 0.5) {
        if (spacingCount === 0) {
          avgSpacing = stepDist;
        } else {
          avgSpacing = 0.7 * avgSpacing + 0.3 * stepDist;
        }
        spacingCount++;
      }

      curTok = bestTok;
    }

    return result;
  }

  /**
   * Estimate the chain-end direction for loop detection.
   * Returns [dx, dy] unit vector pointing outward from the endpoint,
   * or null if unable to compute.
   */
  function _estimateChainEndDir(ids, fromStart, tokenById) {
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
    if (!endTok || !refTok) return null;
    var dx = endTok.x - refTok.x, dy = endTok.y - refTok.y;
    var mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < 0.1) return null;
    return [dx / mag, dy / mag];
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Boundary-aware chain extension (Phase 2)
   *
   *  Grows a chain from one endpoint using the same boundary-following
   *  logic as the Phase 1 tracer.  Maintains chain-level state:
   *  direction, side identity, spacing.
   *
   *  When fromStart=true, new tokens are PREPENDED to the ids array.
   *  When fromStart=false, new tokens are APPENDED.
   *  This preserves chain order — no graph-first rebuild needed.
   *
   *  Returns the number of tokens added.
   * ──────────────────────────────────────────────────────────────────── */
  function _boundaryExtend(ids, fromStart, tokenById, grid, cellSize,
                           traceRadius, traceR2, sideColorGate, dirMin,
                           claimed, adjacency) {
    if (ids.length < 2) return 0;

    // Compute chain-end state from existing tokens
    var endIdx = fromStart ? 0 : ids.length - 1;
    var refIdx = fromStart ? Math.min(3, ids.length - 1) : Math.max(ids.length - 4, 0);
    var endTok = tokenById[ids[endIdx]];
    var refTok = tokenById[ids[refIdx]];
    if (!endTok || !refTok) return 0;

    // Direction: from ref toward end (outward from chain)
    var dirX = endTok.x - refTok.x, dirY = endTok.y - refTok.y;
    var dirMag = Math.sqrt(dirX * dirX + dirY * dirY);
    if (dirMag < 0.5) {
      // Fallback to token tangent
      dirX = fromStart ? -endTok.tangentX : endTok.tangentX;
      dirY = fromStart ? -endTok.tangentY : endTok.tangentY;
    } else {
      dirX /= dirMag; dirY /= dirMag;
    }

    // Side identity: compute from the last few tokens in this direction
    var sideWindow = Math.min(5, ids.length);
    var sLL = 0, sLA = 0, sLB = 0, sRL = 0, sRA = 0, sRB = 0;
    for (var sw = 0; sw < sideWindow; sw++) {
      var swIdx = fromStart ? sw : ids.length - 1 - sw;
      var swTok = tokenById[ids[swIdx]];
      if (!swTok) continue;
      sLL += swTok.leftLab[0]; sLA += swTok.leftLab[1]; sLB += swTok.leftLab[2];
      sRL += swTok.rightLab[0]; sRA += swTok.rightLab[1]; sRB += swTok.rightLab[2];
    }
    sLL /= sideWindow; sLA /= sideWindow; sLB /= sideWindow;
    sRL /= sideWindow; sRA /= sideWindow; sRB /= sideWindow;

    // Average spacing from the last few steps
    var avgSpacing = 0;
    var spacingCount = 0;
    for (var sp = 0; sp < Math.min(5, ids.length - 1); sp++) {
      var spA = fromStart ? sp : ids.length - 1 - sp;
      var spB = fromStart ? sp + 1 : ids.length - 2 - sp;
      if (spB < 0 || spB >= ids.length) break;
      var tA = tokenById[ids[spA]], tB = tokenById[ids[spB]];
      if (!tA || !tB) continue;
      var sdx = tA.x - tB.x, sdy = tA.y - tB.y;
      avgSpacing += Math.sqrt(sdx * sdx + sdy * sdy);
      spacingCount++;
    }
    if (spacingCount > 0) avgSpacing /= spacingCount;

    var added = 0;
    var maxSteps = 100;
    var curTok = endTok;

    for (var step = 0; step < maxSteps; step++) {
      var cgx = (curTok.x / cellSize) | 0;
      var cgy = (curTok.y / cellSize) | 0;

      var bestId = -1;
      var bestScore = -Infinity;
      var bestIsFlipped = false;

      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nk = (cgx + dx) + ',' + (cgy + dy);
          var cell = grid[nk];
          if (!cell) continue;

          for (var ci = 0; ci < cell.length; ci++) {
            var cand = cell[ci];
            if (cand.id === curTok.id || claimed[cand.id]) continue;

            var ddx = cand.x - curTok.x, ddy = cand.y - curTok.y;
            var dist2 = ddx * ddx + ddy * ddy;
            if (dist2 > traceR2 || dist2 < 1) continue;
            var dist = Math.sqrt(dist2);

            // Side-color HARD GATE
            var llD = _labDist(curTok.leftLab, cand.leftLab);
            var rrD = _labDist(curTok.rightLab, cand.rightLab);
            var lrD = _labDist(curTok.leftLab, cand.rightLab);
            var rlD = _labDist(curTok.rightLab, cand.leftLab);
            var sameSideDist = (llD + rrD) * 0.5;
            var flipSideDist = (lrD + rlD) * 0.5;
            var bestColorDist = Math.min(sameSideDist, flipSideDist);
            if (bestColorDist > sideColorGate) continue;

            // Direction continuity
            var connX = ddx / dist, connY = ddy / dist;
            var dirCont = connX * dirX + connY * dirY;
            if (dirCont < dirMin) continue;

            // Lateral distance guard (same as tracer)
            var extLateral = Math.abs(ddx * (-dirY) + ddy * dirX);
            if (extLateral > dist * 0.65) continue;

            dirCont = (dirCont + 1.0) * 0.5;

            // Tangent alignment
            var tangDot = Math.abs(curTok.tangentX * cand.tangentX + curTok.tangentY * cand.tangentY);

            // Chain-level side identity match
            var chainLeft = [sLL, sLA, sLB], chainRight = [sRL, sRA, sRB];
            var sameCD = (_labDist(chainLeft, cand.leftLab) + _labDist(chainRight, cand.rightLab)) * 0.5;
            var flipCD = (_labDist(chainLeft, cand.rightLab) + _labDist(chainRight, cand.leftLab)) * 0.5;
            var chainCD = Math.min(sameCD, flipCD);
            var colorScore = Math.max(0, 1.0 - chainCD / sideColorGate);

            // Spacing regularity
            var spacingScore;
            if (spacingCount >= 2 && avgSpacing > 1) {
              var spacingRatio = dist / avgSpacing;
              spacingScore = Math.max(0, 1.0 - Math.abs(spacingRatio - 1.0));
            } else {
              spacingScore = Math.max(0, 1.0 - dist / traceRadius);
            }

            var score = 0.40 * dirCont + 0.25 * tangDot + 0.20 * colorScore + 0.15 * spacingScore;

            if (score > bestScore) {
              bestScore = score;
              bestId = cand.id;
              bestIsFlipped = flipCD < sameCD;
            }
          }
        }
      }

      if (bestId < 0) break;

      var bestTok = tokenById[bestId];

      // Add to chain in correct position
      if (fromStart) {
        ids.unshift(bestId);
      } else {
        ids.push(bestId);
      }
      claimed[bestId] = true;
      added++;

      // Update adjacency
      var prevId = fromStart ? ids[1] : ids[ids.length - 2];
      adjacency[bestId].push(prevId);
      adjacency[prevId].push(bestId);

      // Update direction (EMA)
      var stepDx = bestTok.x - curTok.x, stepDy = bestTok.y - curTok.y;
      var stepDist = Math.sqrt(stepDx * stepDx + stepDy * stepDy);
      if (stepDist > 0.5) {
        var newDX = stepDx / stepDist, newDY = stepDy / stepDist;
        dirX = 0.60 * newDX + 0.40 * dirX;
        dirY = 0.60 * newDY + 0.40 * dirY;
        var dm = Math.sqrt(dirX * dirX + dirY * dirY);
        if (dm > 0.01) { dirX /= dm; dirY /= dm; }
      }

      // Update side identity (EMA)
      var cLL, cLA, cLB, cRL, cRA, cRB;
      if (bestIsFlipped) {
        cLL = bestTok.rightLab[0]; cLA = bestTok.rightLab[1]; cLB = bestTok.rightLab[2];
        cRL = bestTok.leftLab[0]; cRA = bestTok.leftLab[1]; cRB = bestTok.leftLab[2];
      } else {
        cLL = bestTok.leftLab[0]; cLA = bestTok.leftLab[1]; cLB = bestTok.leftLab[2];
        cRL = bestTok.rightLab[0]; cRA = bestTok.rightLab[1]; cRB = bestTok.rightLab[2];
      }
      // Side-identity EMA with α = 0.15 (slow drift preserves boundary identity)
      sLL = 0.85 * sLL + 0.15 * cLL; sLA = 0.85 * sLA + 0.15 * cLA; sLB = 0.85 * sLB + 0.15 * cLB;
      sRL = 0.85 * sRL + 0.15 * cRL; sRA = 0.85 * sRA + 0.15 * cRA; sRB = 0.85 * sRB + 0.15 * cRB;

      // Update spacing
      if (stepDist > 0.5) {
        avgSpacing = spacingCount > 0 ? (0.7 * avgSpacing + 0.3 * stepDist) : stepDist;
        spacingCount++;
      }

      curTok = bestTok;
    }

    return added;
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Structural merge (Phase 2)
   *
   *  Merges chain pairs that are clearly on the same boundary.
   *
   *  For each pair of chain endpoints (A_end, B_start or B_end):
   *    1. Proximity: endpoint gap within merge radius
   *    2. Direction: both chain-end directions point toward each other
   *    3. Side pattern: left/right LAB colors match
   *    4. Tangent alignment: endpoint tangents are compatible
   *
   *  When two chains merge:
   *    - One chain's ids are concatenated onto the other
   *    - Adjacency is updated (link between the joining endpoints)
   *    - The consumed chain is marked empty
   *
   *  This replaces the old _bridgePass which only checked endpoint
   *  proximity and tangent alignment, without chain-level side identity.
   * ──────────────────────────────────────────────────────────────────── */
  function _structuralMerge(chains, loops, adjacency, tokenById, claimed, cfg) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    var mergeRadius = cfg.bridgeMaxGapPx || 36;
    var mergeR2 = mergeRadius * mergeRadius;
    var mergeDirMin = 0.45; // endpoints must genuinely face toward each other (~63° max deviation)
    var mergeSideTol = sideColorGate; // side identity must match

    var mergeCount = 0;
    var mergeEdgeList = [];

    // Collect endpoint info for all chains
    // ep = { tok, chainIdx, isStart, dirX, dirY, sideLeft[3], sideRight[3] }
    function _chainEndInfo(ch, isStart, chainIdx) {
      var ids = ch.ids;
      if (ids.length < 2) return null;
      var endIdx = isStart ? 0 : ids.length - 1;
      var refIdx = isStart ? Math.min(3, ids.length - 1) : Math.max(ids.length - 4, 0);
      var endTok = tokenById[ids[endIdx]];
      var refTok = tokenById[ids[refIdx]];
      if (!endTok || !refTok) return null;

      var dx = endTok.x - refTok.x, dy = endTok.y - refTok.y;
      var mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < 0.5) {
        dx = isStart ? -endTok.tangentX : endTok.tangentX;
        dy = isStart ? -endTok.tangentY : endTok.tangentY;
      } else {
        dx /= mag; dy /= mag;
      }

      // Average side identity from last few tokens at this end
      var sWindow = Math.min(5, ids.length);
      var sL = [0, 0, 0], sR = [0, 0, 0];
      for (var si = 0; si < sWindow; si++) {
        var sIdx = isStart ? si : ids.length - 1 - si;
        var sTok = tokenById[ids[sIdx]];
        if (!sTok) continue;
        sL[0] += sTok.leftLab[0]; sL[1] += sTok.leftLab[1]; sL[2] += sTok.leftLab[2];
        sR[0] += sTok.rightLab[0]; sR[1] += sTok.rightLab[1]; sR[2] += sTok.rightLab[2];
      }
      sL[0] /= sWindow; sL[1] /= sWindow; sL[2] /= sWindow;
      sR[0] /= sWindow; sR[1] /= sWindow; sR[2] /= sWindow;

      return {
        tok: endTok, chainIdx: chainIdx, isStart: isStart,
        dirX: dx, dirY: dy, sideLeft: sL, sideRight: sR
      };
    }

    // Build endpoint list
    var endpoints = [];
    for (var ei = 0; ei < chains.length; ei++) {
      if (chains[ei].ids.length < 2) continue;
      var epStart = _chainEndInfo(chains[ei], true, ei);
      var epEnd = _chainEndInfo(chains[ei], false, ei);
      if (epStart) endpoints.push(epStart);
      if (epEnd) endpoints.push(epEnd);
    }

    // Spatial index for endpoints
    var epCellSize = mergeRadius + 1;
    var epGrid = {};
    for (var gi = 0; gi < endpoints.length; gi++) {
      var ep = endpoints[gi];
      var gk = ((ep.tok.x / epCellSize) | 0) + ',' + ((ep.tok.y / epCellSize) | 0);
      if (!epGrid[gk]) epGrid[gk] = [];
      epGrid[gk].push(ep);
    }

    // Track which chains have been merged (consumed)
    var consumed = {};

    // Try to merge each endpoint pair
    for (var pi = 0; pi < endpoints.length; pi++) {
      var epA = endpoints[pi];
      if (consumed[epA.chainIdx]) continue;

      var tokA = epA.tok;
      var agx = (tokA.x / epCellSize) | 0;
      var agy = (tokA.y / epCellSize) | 0;

      var bestMerge = null;
      var bestMergeScore = -1;

      for (var mdy = -1; mdy <= 1; mdy++) {
        for (var mdx = -1; mdx <= 1; mdx++) {
          var mBucket = epGrid[(agx + mdx) + ',' + (agy + mdy)];
          if (!mBucket) continue;
          for (var mj = 0; mj < mBucket.length; mj++) {
            var epB = mBucket[mj];
            if (epB.chainIdx === epA.chainIdx) continue; // same chain
            if (consumed[epB.chainIdx]) continue;

            var tokB = epB.tok;
            var gdx = tokB.x - tokA.x, gdy = tokB.y - tokA.y;
            var gap2 = gdx * gdx + gdy * gdy;
            if (gap2 > mergeR2 || gap2 < 1) continue;
            var gap = Math.sqrt(gap2);
            var gapDirX = gdx / gap, gapDirY = gdy / gap;

            // ── Check 1: Direction — endpoints face toward each other ──
            // A's direction should point toward B (positive dot with gap direction)
            var aDotGap = epA.dirX * gapDirX + epA.dirY * gapDirY;
            // B's direction should point toward A (negative dot with gap direction)
            var bDotGap = epB.dirX * (-gapDirX) + epB.dirY * (-gapDirY);

            if (aDotGap < mergeDirMin || bDotGap < mergeDirMin) continue;

            // ── Check 1b: Lateral offset guard ──
            // If the gap is mostly lateral (perpendicular to both chain
            // directions), the endpoints are on parallel boundaries, not
            // the same boundary.  Compute the lateral component of the gap
            // relative to the average chain direction.
            var avgMergeDirX = epA.dirX + epB.dirX;
            var avgMergeDirY = epA.dirY + epB.dirY;
            var avgMergeMag = Math.sqrt(avgMergeDirX * avgMergeDirX + avgMergeDirY * avgMergeDirY);
            if (avgMergeMag > 0.01) {
              avgMergeDirX /= avgMergeMag; avgMergeDirY /= avgMergeMag;
              var lateralOffset = Math.abs(gdx * (-avgMergeDirY) + gdy * avgMergeDirX);
              // Reject if lateral offset exceeds 40% of the gap distance
              // (i.e., the gap is more sideways than forward)
              if (lateralOffset > gap * 0.40) continue;
            }

            // ── Check 2: Side-pattern match ──
            // The chains' accumulated side identities must be compatible
            var sameSide = (_labDist(epA.sideLeft, epB.sideLeft) +
                           _labDist(epA.sideRight, epB.sideRight)) * 0.5;
            var flipSide = (_labDist(epA.sideLeft, epB.sideRight) +
                           _labDist(epA.sideRight, epB.sideLeft)) * 0.5;
            var bestSideDist = Math.min(sameSide, flipSide);
            if (bestSideDist > mergeSideTol) continue;

            // ── Check 3: Tangent alignment at endpoints ──
            var tangDot = Math.abs(tokA.tangentX * tokB.tangentX + tokA.tangentY * tokB.tangentY);
            if (tangDot < 0.40) continue; // tightened: prevent perpendicular boundary merging

            // Score: direction matching + side consistency + tangent + proximity
            var dirScore = (aDotGap + bDotGap) * 0.5;
            var sideScore = Math.max(0, 1.0 - bestSideDist / mergeSideTol);
            var proxScore = Math.max(0, 1.0 - gap / mergeRadius);
            var mScore = 0.35 * dirScore + 0.30 * sideScore + 0.20 * tangDot + 0.15 * proxScore;

            if (mScore > bestMergeScore) {
              bestMergeScore = mScore;
              bestMerge = epB;
            }
          }
        }
      }

      if (!bestMerge) continue;

      // Execute merge: concatenate chain B into chain A
      var chA = chains[epA.chainIdx];
      var chB = chains[bestMerge.chainIdx];

      // Determine concatenation order based on which endpoints are connecting
      // epA.isStart / bestMerge.isStart determine orientation
      var idsA = chA.ids;
      var idsB = chB.ids;
      var merged;

      if (!epA.isStart && bestMerge.isStart) {
        // A_end → B_start: append B after A
        merged = idsA.concat(idsB);
      } else if (epA.isStart && !bestMerge.isStart) {
        // A_start ← B_end: prepend B before A
        merged = idsB.concat(idsA);
      } else if (!epA.isStart && !bestMerge.isStart) {
        // A_end → B_end: append reversed B after A
        merged = idsA.concat(idsB.slice().reverse());
      } else {
        // A_start → B_start: prepend reversed B before A
        merged = idsB.slice().reverse().concat(idsA);
      }

      chA.ids = merged;

      // Add adjacency link between the joining endpoints
      var joinIdA = epA.tok.id, joinIdB = bestMerge.tok.id;
      adjacency[joinIdA].push(joinIdB);
      adjacency[joinIdB].push(joinIdA);

      mergeEdgeList.push([joinIdA, joinIdB]);
      mergeCount++;

      // Mark chain B as consumed
      chB.ids = [];
      consumed[bestMerge.chainIdx] = true;
    }

    // Remove empty chains
    var finalChains = [];
    var finalLoops = [];
    for (var fi = 0; fi < chains.length; fi++) {
      if (chains[fi].ids.length >= (cfg.chainMinLength || 2)) {
        finalChains.push(chains[fi]);
        // Re-check loop status after merging
        if (chains[fi].ids.length >= 6) {
          var fIds = chains[fi].ids;
          var fFirst = tokenById[fIds[0]], fLast = tokenById[fIds[fIds.length - 1]];
          if (fFirst && fLast) {
            var fdx = fFirst.x - fLast.x, fdy = fFirst.y - fLast.y;
            if (fdx * fdx + fdy * fdy < mergeR2) {
              finalLoops.push({ ids: fIds });
            }
          }
        }
      }
    }

    return {
      chains: finalChains,
      loops: finalLoops,
      mergeCount: mergeCount,
      mergeEdgeList: mergeEdgeList
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Noise classification (Phase 2)
   *
   *  Orphan tokens (not in any chain) are classified by structural role
   *  rather than force-linked.  Classification:
   *
   *    'boundary' — tokens that are in chains (included for completeness)
   *    'interior' — orphan tokens surrounded mostly by same-color neighbors,
   *                 indicating they're inside an object, not on a boundary
   *    'weak'     — orphan tokens with low confidence or few nearby tokens,
   *                 representing weak/ambiguous boundary evidence
   *    'unresolved' — orphan tokens that could be boundary but couldn't be
   *                   connected (gaps, intersections, noise)
   *
   *  This replaces the coverage enforcement sweep.  Downstream stages
   *  can use classification to weight token contributions differently.
   * ──────────────────────────────────────────────────────────────────── */
  function _classifyOrphanTokens(tokens, chains, tokenById, grid, cellSize, cfg) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;

    // Build set of chained token IDs
    var inChain = {};
    for (var ci = 0; ci < chains.length; ci++) {
      var ch = chains[ci].ids;
      for (var cj = 0; cj < ch.length; cj++) inChain[ch[cj]] = true;
    }

    var classification = {};

    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];

      if (inChain[tok.id]) {
        classification[tok.id] = 'boundary';
        continue;
      }

      // Orphan token — classify it
      var cgx = (tok.x / cellSize) | 0;
      var cgy = (tok.y / cellSize) | 0;

      // Count nearby tokens and their boundary diversity
      var nearbyCount = 0;
      var sameBoundaryCount = 0;
      var radius2 = cellSize * cellSize * 4; // search within 2 cells

      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          var nk = (cgx + dx) + ',' + (cgy + dy);
          var cell = grid[nk];
          if (!cell) continue;
          for (var ni = 0; ni < cell.length; ni++) {
            var nb = cell[ni];
            if (nb.id === tok.id) continue;
            var ddx = nb.x - tok.x, ddy = nb.y - tok.y;
            if (ddx * ddx + ddy * ddy > radius2) continue;
            nearbyCount++;

            // Check if same boundary identity
            var llD = _labDist(tok.leftLab, nb.leftLab);
            var rrD = _labDist(tok.rightLab, nb.rightLab);
            var lrD = _labDist(tok.leftLab, nb.rightLab);
            var rlD = _labDist(tok.rightLab, nb.leftLab);
            var bestCD = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
            if (bestCD <= sideColorGate) sameBoundaryCount++;
          }
        }
      }

      if (nearbyCount < 2) {
        // Very few neighbors — weak evidence
        classification[tok.id] = 'weak';
      } else if (tok.confidence < 0.15) {
        // Low confidence token
        classification[tok.id] = 'weak';
      } else if (tok.deltaE != null && tok.deltaE < 5) {
        // Very low color contrast — likely interior
        classification[tok.id] = 'interior';
      } else if (sameBoundaryCount > 0 && sameBoundaryCount >= nearbyCount * 0.5) {
        // Has nearby same-boundary tokens but couldn't connect —
        // likely at an intersection, gap, or ambiguous region
        classification[tok.id] = 'unresolved';
      } else {
        // Has neighbors but they're all from different boundaries —
        // likely interior clutter where many boundaries meet
        classification[tok.id] = 'interior';
      }
    }

    return classification;
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Boundary-aware closure (Phase 3)
   *
   *  For each non-loop chain, check if its endpoints can be connected
   *  to form a closed loop.  Closure requires:
   *    1. Endpoints within closure radius
   *    2. Chain-end directions converge toward each other
   *    3. Side-color identity consistent between endpoints
   *    4. Chain curvature supports closure (no sharp reversal)
   *
   *  When a chain closes, the last→first adjacency link is added and
   *  the chain is marked as a loop.
   * ──────────────────────────────────────────────────────────────────── */
  function _boundaryAwareClosure(chains, loops, adjacency, tokenById, cfg) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    var closureMaxGap = cfg.closureMaxGapPx || 40;
    var closureMaxGap2 = closureMaxGap * closureMaxGap;
    var closureMinLen = cfg.closureMinChainLen || 6;
    var closureDirMin = 0.30; // endpoints must face toward each other

    // Build set of existing loop chain IDs
    var loopChainSet = {};
    for (var li = 0; li < loops.length; li++) {
      var lids = loops[li].ids;
      if (lids.length > 0) loopChainSet[lids[0] + ',' + lids[lids.length - 1]] = true;
    }

    var newLoops = loops.slice(); // copy existing loops
    var closureCount = 0;

    for (var ci = 0; ci < chains.length; ci++) {
      var ch = chains[ci];
      var ids = ch.ids;
      if (ids.length < closureMinLen) continue;

      // Skip if already a loop
      var loopKey = ids[0] + ',' + ids[ids.length - 1];
      if (loopChainSet[loopKey]) continue;

      var firstTok = tokenById[ids[0]];
      var lastTok = tokenById[ids[ids.length - 1]];
      if (!firstTok || !lastTok) continue;

      // Check endpoint proximity
      var gdx = firstTok.x - lastTok.x, gdy = firstTok.y - lastTok.y;
      var gap2 = gdx * gdx + gdy * gdy;
      if (gap2 > closureMaxGap2 || gap2 < 1) continue;

      var gap = Math.sqrt(gap2);
      var gapDirX = gdx / gap, gapDirY = gdy / gap;

      // Chain-end directions (outward from each end)
      var lastDir = _estimateChainEndDir(ids, false, tokenById);
      var firstDir = _estimateChainEndDir(ids, true, tokenById);
      if (!lastDir || !firstDir) continue;

      // Last end should point toward first (positive dot with gap direction)
      var lastToFirst = lastDir[0] * gapDirX + lastDir[1] * gapDirY;
      // First end should point toward last (negative dot)
      var firstToLast = firstDir[0] * (-gapDirX) + firstDir[1] * (-gapDirY);

      if (lastToFirst < closureDirMin || firstToLast < closureDirMin) continue;

      // Side-color consistency between endpoints
      var llD = _labDist(firstTok.leftLab, lastTok.leftLab);
      var rrD = _labDist(firstTok.rightLab, lastTok.rightLab);
      var lrD = _labDist(firstTok.leftLab, lastTok.rightLab);
      var rlD = _labDist(firstTok.rightLab, lastTok.leftLab);
      var bestCD = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
      if (bestCD > sideColorGate) continue;

      // Curvature check: the chain's overall shape should support closure.
      // Compute the chain's average turning rate from its direction changes.
      // If the chain is nearly straight, closing it would create an
      // unnatural sharp fold at the endpoints.
      var totalTurn = 0;
      var turnCount = 0;
      for (var ti = 1; ti < ids.length - 1; ti++) {
        var tPrev = tokenById[ids[ti - 1]];
        var tCur = tokenById[ids[ti]];
        var tNext = tokenById[ids[ti + 1]];
        if (!tPrev || !tCur || !tNext) continue;
        var d1x = tCur.x - tPrev.x, d1y = tCur.y - tPrev.y;
        var d2x = tNext.x - tCur.x, d2y = tNext.y - tCur.y;
        var m1 = Math.sqrt(d1x * d1x + d1y * d1y);
        var m2 = Math.sqrt(d2x * d2x + d2y * d2y);
        if (m1 > 0.5 && m2 > 0.5) {
          var turnDot = (d1x * d2x + d1y * d2y) / (m1 * m2);
          totalTurn += Math.acos(Math.max(-1, Math.min(1, turnDot)));
          turnCount++;
        }
      }
      // For a closed loop, accumulated turning should be roughly 2π (360°).
      // Accept if total turn is at least π (180°) — allows for partial loops
      // and irregular shapes.
      if (turnCount > 0) {
        var avgTurnPerStep = totalTurn / turnCount;
        var expectedTotalTurn = avgTurnPerStep * ids.length;
        // Reject if the chain would need to turn > 90° at the closure point
        // to complete the loop (indicating it's not naturally curving)
        var closureTurn = Math.acos(Math.max(-1, Math.min(1,
          lastDir[0] * (-firstDir[0]) + lastDir[1] * (-firstDir[1]))));
        if (closureTurn > Math.PI * 0.5 && expectedTotalTurn < Math.PI) continue;
      }

      // Close the loop
      var firstId = ids[0], lastId = ids[ids.length - 1];
      // Check not already linked
      var alreadyClosed = false;
      for (var ali = 0; ali < adjacency[lastId].length; ali++) {
        if (adjacency[lastId][ali] === firstId) { alreadyClosed = true; break; }
      }
      if (!alreadyClosed) {
        adjacency[lastId].push(firstId);
        adjacency[firstId].push(lastId);
      }
      newLoops.push({ ids: ids });
      closureCount++;
    }

    return { chains: chains, loops: newLoops, closureCount: closureCount };
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Jump detection and chain splitting (Phase 3)
   *
   *  Walks each chain and identifies anomalous discontinuities:
   *    - Large distance jumps (> 3× the chain's median step spacing)
   *    - Sharp direction breaks (> 90° turn at a single step)
   *
   *  When a jump is found, the chain is split at that point into two
   *  separate chains.  The adjacency link at the jump is removed.
   *
   *  This catches residual cross-boundary connections and large invalid
   *  jumps that survived the tracer/extension.
   * ──────────────────────────────────────────────────────────────────── */
  function _detectAndSplitJumps(chains, loops, adjacency, tokenById, cfg) {
    var minChainLen = cfg.chainMinLength || 2;
    var jumpDistMultiplier = 3.0;  // jump if step > 3× median spacing
    var jumpAngleMax = Math.cos(Math.PI * 0.55); // ~99° — nearly perpendicular turn

    var newChains = [];
    var newLoops = [];

    for (var ci = 0; ci < chains.length; ci++) {
      var ids = chains[ci].ids;
      if (ids.length < 4) {
        // Too short to analyze — keep as-is
        if (ids.length >= minChainLen) newChains.push(chains[ci]);
        continue;
      }

      // Compute step distances
      var stepDists = [];
      for (var si = 0; si < ids.length - 1; si++) {
        var tA = tokenById[ids[si]], tB = tokenById[ids[si + 1]];
        if (!tA || !tB) { stepDists.push(0); continue; }
        var sdx = tB.x - tA.x, sdy = tB.y - tA.y;
        stepDists.push(Math.sqrt(sdx * sdx + sdy * sdy));
      }

      // Median step distance
      var sortedDists = stepDists.slice().sort(function(a, b) { return a - b; });
      var medianDist = sortedDists[Math.floor(sortedDists.length / 2)];
      var jumpThreshold = Math.max(medianDist * jumpDistMultiplier, 20); // at least 20px

      // Find jump points
      var jumpIndices = []; // indices where the jump occurs (between [i] and [i+1])
      for (var ji = 0; ji < stepDists.length; ji++) {
        // Distance jump
        if (stepDists[ji] > jumpThreshold) {
          jumpIndices.push(ji);
          continue;
        }
        // Direction break (sharp turn)
        if (ji > 0 && ji < stepDists.length - 1) {
          var tPrev = tokenById[ids[ji]];
          var tCur = tokenById[ids[ji + 1]];
          var tPrev2 = tokenById[ids[ji - 1 >= 0 ? ji - 1 : 0]]; // step before
          if (tPrev && tCur && tPrev2 && stepDists[ji] > 1 && stepDists[ji - 1] > 1) {
            var d1x = tPrev.x - tPrev2.x, d1y = tPrev.y - tPrev2.y;
            var d2x = tCur.x - tPrev.x, d2y = tCur.y - tPrev.y;
            var dm1 = Math.sqrt(d1x * d1x + d1y * d1y);
            var dm2 = Math.sqrt(d2x * d2x + d2y * d2y);
            if (dm1 > 0.5 && dm2 > 0.5) {
              var turnDot = (d1x * d2x + d1y * d2y) / (dm1 * dm2);
              if (turnDot < jumpAngleMax) {
                jumpIndices.push(ji);
              }
            }
          }
        }
      }

      if (jumpIndices.length === 0) {
        // No jumps — keep chain as-is
        newChains.push(chains[ci]);
        // Check if it was a loop
        for (var lci = 0; lci < loops.length; lci++) {
          if (loops[lci].ids === ids) { newLoops.push(loops[lci]); break; }
        }
        continue;
      }

      // Split chain at jump points
      var splitPoints = [0];
      for (var spi = 0; spi < jumpIndices.length; spi++) {
        splitPoints.push(jumpIndices[spi] + 1);
      }
      splitPoints.push(ids.length);

      for (var ssi = 0; ssi < splitPoints.length - 1; ssi++) {
        var segStart = splitPoints[ssi];
        var segEnd = splitPoints[ssi + 1];
        var segIds = ids.slice(segStart, segEnd);
        if (segIds.length >= minChainLen) {
          newChains.push({ ids: segIds, ordered: true });
        }
      }

      // Remove adjacency links at jump points
      for (var rji = 0; rji < jumpIndices.length; rji++) {
        var jumpIdx = jumpIndices[rji];
        var idFrom = ids[jumpIdx], idTo = ids[jumpIdx + 1];
        // Remove idTo from idFrom's adjacency
        var fromAdj = adjacency[idFrom];
        for (var rai = fromAdj.length - 1; rai >= 0; rai--) {
          if (fromAdj[rai] === idTo) { fromAdj.splice(rai, 1); break; }
        }
        // Remove idFrom from idTo's adjacency
        var toAdj = adjacency[idTo];
        for (var rai2 = toAdj.length - 1; rai2 >= 0; rai2--) {
          if (toAdj[rai2] === idFrom) { toAdj.splice(rai2, 1); break; }
        }
      }
    }

    return { chains: newChains, loops: newLoops };
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Structure dominance (Phase 3)
   *
   *  Prioritizes structurally meaningful chains and removes fragments
   *  that represent cross-boundary noise or interior clutter.
   *
   *  Criteria for removal:
   *    1. Short fragments (< 4 tokens) that are NOT part of a loop
   *    2. Chains whose spatial extent is tiny relative to the image
   *    3. Chains with inconsistent internal side-color (boundary identity
   *       flips mid-chain, indicating it crossed a boundary)
   *
   *  Criteria for preservation (even if short):
   *    1. Part of a closed loop
   *    2. High average confidence tokens
   *    3. Consistent side-color throughout
   * ──────────────────────────────────────────────────────────────────── */
  function _applyStructureDominance(chains, loops, adjacency, tokenById, cfg) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    var minFragmentLen = 4; // minimum tokens to survive without loop protection
    var W = cfg.imageWidth || 1;
    var H = cfg.imageHeight || 1;
    var imageDiag = Math.sqrt(W * W + H * H);

    // Build loop membership set
    var loopChainFirstLast = {};
    for (var li = 0; li < loops.length; li++) {
      var lids = loops[li].ids;
      if (lids.length > 0) {
        loopChainFirstLast[lids[0] + ',' + lids[lids.length - 1]] = true;
      }
    }

    var keptChains = [];
    var keptLoops = [];

    for (var ci = 0; ci < chains.length; ci++) {
      var ch = chains[ci];
      var ids = ch.ids;
      if (ids.length < 2) continue;

      // Check if this chain is part of a loop
      var isLoop = loopChainFirstLast[ids[0] + ',' + ids[ids.length - 1]] || false;

      // Loops are always kept
      if (isLoop) {
        keptChains.push(ch);
        keptLoops.push({ ids: ids });
        continue;
      }

      // Short fragments: check if they should be kept
      if (ids.length < minFragmentLen) {
        // Keep short fragments only if they have high confidence
        var avgConf = 0;
        for (var cci = 0; cci < ids.length; cci++) {
          var ct = tokenById[ids[cci]];
          if (ct) avgConf += ct.confidence;
        }
        avgConf /= ids.length;
        if (avgConf < 0.25) {
          // Low confidence short fragment — remove
          _removeChainAdjacency(ids, adjacency);
          continue;
        }
      }

      // Internal side-color consistency check:
      // Walk the chain and check if side identity flips compared to the
      // chain's average.  A boundary-crossing chain will have tokens
      // where left/right are swapped relative to the majority.
      var flipCount = 0;
      if (ids.length >= 4) {
        // Compute chain's average side identity from first quarter
        var sampleLen = Math.min(Math.ceil(ids.length * 0.25), 8);
        var avgL = [0, 0, 0], avgR = [0, 0, 0];
        for (var sai = 0; sai < sampleLen; sai++) {
          var st = tokenById[ids[sai]];
          if (!st) continue;
          avgL[0] += st.leftLab[0]; avgL[1] += st.leftLab[1]; avgL[2] += st.leftLab[2];
          avgR[0] += st.rightLab[0]; avgR[1] += st.rightLab[1]; avgR[2] += st.rightLab[2];
        }
        avgL[0] /= sampleLen; avgL[1] /= sampleLen; avgL[2] /= sampleLen;
        avgR[0] /= sampleLen; avgR[1] /= sampleLen; avgR[2] /= sampleLen;

        // Check rest of chain for consistency
        for (var sci = sampleLen; sci < ids.length; sci++) {
          var sct = tokenById[ids[sci]];
          if (!sct) continue;
          var sameD = (_labDist(avgL, sct.leftLab) + _labDist(avgR, sct.rightLab)) * 0.5;
          var flipD = (_labDist(avgL, sct.rightLab) + _labDist(avgR, sct.leftLab)) * 0.5;
          // If flipped is closer than same, this token's boundary identity is inconsistent
          if (flipD < sameD && sameD - flipD > 10) flipCount++;
        }

        var checkLen = ids.length - sampleLen;
        if (checkLen > 0 && flipCount / checkLen > 0.35) {
          // >35% of tokens have flipped side identity — this chain likely
          // crosses a boundary.  Split it at the flip point or remove if short.
          if (ids.length < 8) {
            _removeChainAdjacency(ids, adjacency);
            continue;
          }
          // For longer chains, keep them — they may be at a legitimate
          // boundary transition (e.g., corner of touching objects)
        }
      }

      // Spatial extent check: chains spanning a tiny area are likely noise
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (var xi = 0; xi < ids.length; xi++) {
        var xt = tokenById[ids[xi]];
        if (!xt) continue;
        if (xt.x < minX) minX = xt.x;
        if (xt.x > maxX) maxX = xt.x;
        if (xt.y < minY) minY = xt.y;
        if (xt.y > maxY) maxY = xt.y;
      }
      var extent = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY));

      // Remove chains that span < 0.5% of the image diagonal AND are short
      if (extent < imageDiag * 0.005 && ids.length < 6) {
        _removeChainAdjacency(ids, adjacency);
        continue;
      }

      keptChains.push(ch);
    }

    return { chains: keptChains, loops: keptLoops };
  }

  /**
   * Remove adjacency links for a chain being discarded.
   */
  function _removeChainAdjacency(ids, adjacency) {
    for (var ri = 0; ri < ids.length - 1; ri++) {
      var idA = ids[ri], idB = ids[ri + 1];
      var adjA = adjacency[idA];
      if (adjA) {
        for (var rai = adjA.length - 1; rai >= 0; rai--) {
          if (adjA[rai] === idB) { adjA.splice(rai, 1); break; }
        }
      }
      var adjB = adjacency[idB];
      if (adjB) {
        for (var rbi = adjB.length - 1; rbi >= 0; rbi--) {
          if (adjB[rbi] === idA) { adjB.splice(rbi, 1); break; }
        }
      }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Boundary contour consolidation (Phase 4)
   *
   *  Merges fragments that belong to the same object boundary into
   *  unified chains.  Works at boundary IDENTITY level, not just
   *  local endpoint proximity.
   *
   *  Algorithm:
   *    1. Compute per-chain boundary signature (avg left/right LAB)
   *    2. Build a pairwise compatibility graph between chains:
   *       two chains are compatible if their side-color signatures match
   *       AND they are spatially close (any token in A is near any token in B)
   *    3. Find connected components in the compatibility graph →
   *       these are boundary groups (all fragments of the same boundary)
   *    4. Within each group, order chains spatially along the contour
   *       using a nearest-endpoint walk
   *    5. Concatenate into unified chains, adding adjacency links
   *       at junction points (corners, curves)
   *    6. Re-detect loops on unified chains
   *
   *  Key: the spatial proximity check uses a generous radius so that
   *  fragments separated by a corner (where the tracer terminated)
   *  still cluster together.  The side-color match ensures fragments
   *  from different boundaries (even if spatially close) stay separate.
   * ──────────────────────────────────────────────────────────────────── */
  function _consolidateBoundaryContours(chains, loops, adjacency, tokenById, cfg) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    // Proximity threshold for any-token-to-any-token spatial connectivity.
    // Fragments along the same boundary typically have tokens within a few
    // pixels of each other.  Separate objects are typically much farther apart.
    // Connected components in the spatial graph naturally separate distinct
    // objects even when they share the same side-color signature.
    var proximityThreshold = cfg.consolidationProximityPx || 50;
    var proxThresh2 = proximityThreshold * proximityThreshold;
    var chainMinLen = cfg.chainMinLength || 2;

    if (chains.length < 2) return { chains: chains, loops: loops };

    // ── Step 1: Compute per-chain boundary signature (avg left/right LAB) ──
    var sigs = [];
    for (var ci = 0; ci < chains.length; ci++) {
      var ids = chains[ci].ids;
      if (ids.length < 1) continue;
      var sL = [0, 0, 0], sR = [0, 0, 0], n = 0;
      for (var ti = 0; ti < ids.length; ti++) {
        var tok = tokenById[ids[ti]];
        if (!tok) continue;
        sL[0] += tok.leftLab[0]; sL[1] += tok.leftLab[1]; sL[2] += tok.leftLab[2];
        sR[0] += tok.rightLab[0]; sR[1] += tok.rightLab[1]; sR[2] += tok.rightLab[2];
        n++;
      }
      if (n === 0) continue;
      sigs.push({
        avgLeft: [sL[0] / n, sL[1] / n, sL[2] / n],
        avgRight: [sR[0] / n, sR[1] / n, sR[2] / n],
        chainIdx: ci,
        tokenCount: n
      });
    }

    // ── Step 2: Group chains by side-color identity ──
    // Two chains share boundary identity if their avg left/right LAB match
    // (or are flipped) within the sideColorGate.  We build a color-match
    // graph and extract connected components — these are "color groups"
    // that MIGHT belong to the same boundary (but could be separate objects
    // with the same colors).
    var colorAdj = {};
    for (var i = 0; i < sigs.length; i++) colorAdj[i] = {};

    for (var ai = 0; ai < sigs.length; ai++) {
      var sigA = sigs[ai];
      for (var bi = ai + 1; bi < sigs.length; bi++) {
        var sigB = sigs[bi];
        var sameDist = (_labDist(sigA.avgLeft, sigB.avgLeft) +
                       _labDist(sigA.avgRight, sigB.avgRight)) * 0.5;
        var flipDist = (_labDist(sigA.avgLeft, sigB.avgRight) +
                       _labDist(sigA.avgRight, sigB.avgLeft)) * 0.5;
        if (Math.min(sameDist, flipDist) <= sideColorGate) {
          colorAdj[ai][bi] = true;
          colorAdj[bi][ai] = true;
        }
      }
    }

    var colorVisited = {};
    var colorGroups = [];
    for (var cgi = 0; cgi < sigs.length; cgi++) {
      if (colorVisited[cgi]) continue;
      var cg = [];
      var cq = [cgi];
      colorVisited[cgi] = true;
      while (cq.length > 0) {
        var ccur = cq.shift();
        cg.push(ccur);
        for (var cnk in colorAdj[ccur]) {
          var cni = +cnk;
          if (!colorVisited[cni]) {
            colorVisited[cni] = true;
            cq.push(cni);
          }
        }
      }
      colorGroups.push(cg);
    }

    // ── Step 3: Build spatial index of ALL chain tokens ──
    var proxCellSize = proximityThreshold + 1;
    var proxGrid = {};

    for (var si = 0; si < sigs.length; si++) {
      var chIds = chains[sigs[si].chainIdx].ids;
      for (var tii = 0; tii < chIds.length; tii++) {
        var ttok = tokenById[chIds[tii]];
        if (!ttok) continue;
        var pgk = ((ttok.x / proxCellSize) | 0) + ',' + ((ttok.y / proxCellSize) | 0);
        if (!proxGrid[pgk]) proxGrid[pgk] = [];
        proxGrid[pgk].push({ tok: ttok, sigIdx: si });
      }
    }

    // ── Step 4: Within each color group, find spatially connected components ──
    //
    // This is the key separation mechanism: chains on different objects
    // share the same side colors but are physically far apart.  Connected
    // components in the any-token-to-any-token proximity graph naturally
    // separate distinct objects.  Fragments along the SAME boundary are
    // physically close (within proximityThreshold) and will cluster together.
    var finalGroups = [];

    for (var cgIdx = 0; cgIdx < colorGroups.length; cgIdx++) {
      var cGroup = colorGroups[cgIdx];

      if (cGroup.length === 1) {
        finalGroups.push(cGroup);
        continue;
      }

      // Build set for O(1) membership check
      var inGroup = {};
      for (var ig = 0; ig < cGroup.length; ig++) inGroup[cGroup[ig]] = true;

      // Build spatial adjacency between chains in this color group.
      // Two chains are spatially connected if ANY token in one is within
      // proximityThreshold of ANY token in the other.
      var spatialAdj = {};
      for (var ig2 = 0; ig2 < cGroup.length; ig2++) spatialAdj[cGroup[ig2]] = {};

      for (var ig3 = 0; ig3 < cGroup.length; ig3++) {
        var sigIdx = cGroup[ig3];
        var schIds = chains[sigs[sigIdx].chainIdx].ids;

        for (var sti = 0; sti < schIds.length; sti++) {
          var stok = tokenById[schIds[sti]];
          if (!stok) continue;

          var sgx = (stok.x / proxCellSize) | 0;
          var sgy = (stok.y / proxCellSize) | 0;

          for (var sdy = -1; sdy <= 1; sdy++) {
            for (var sdx = -1; sdx <= 1; sdx++) {
              var sBucket = proxGrid[(sgx + sdx) + ',' + (sgy + sdy)];
              if (!sBucket) continue;
              for (var sbi = 0; sbi < sBucket.length; sbi++) {
                var sOther = sBucket[sbi];
                if (sOther.sigIdx === sigIdx) continue;
                if (!inGroup[sOther.sigIdx]) continue;
                if (spatialAdj[sigIdx][sOther.sigIdx]) continue;

                var sddx = sOther.tok.x - stok.x;
                var sddy = sOther.tok.y - stok.y;
                if (sddx * sddx + sddy * sddy <= proxThresh2) {
                  spatialAdj[sigIdx][sOther.sigIdx] = true;
                  spatialAdj[sOther.sigIdx][sigIdx] = true;
                }
              }
            }
          }
        }
      }

      // BFS to find spatial connected components within this color group
      var spVisited = {};
      for (var ig4 = 0; ig4 < cGroup.length; ig4++) {
        var spIdx = cGroup[ig4];
        if (spVisited[spIdx]) continue;
        var comp = [];
        var sq = [spIdx];
        spVisited[spIdx] = true;
        while (sq.length > 0) {
          var sc = sq.shift();
          comp.push(sc);
          for (var snk in spatialAdj[sc]) {
            var sni = +snk;
            if (!spVisited[sni]) {
              spVisited[sni] = true;
              sq.push(sni);
            }
          }
        }
        finalGroups.push(comp);
      }
    }

    // ── Step 5: Within each group, order fragments and concatenate ──
    //
    // For each group of chains that share boundary identity AND are
    // spatially connected, we form a single unified chain:
    //   1. Determine side-color orientation (flipped or not) relative to
    //      a reference chain in the group
    //   2. Start from the fragment whose endpoint is farthest from centroid
    //   3. Greedily walk to the nearest unvisited fragment (by endpoint
    //      distance), orienting each fragment to minimize the gap
    //   4. Concatenate all fragments into one chain
    var newChains = [];
    var newLoops = [];

    for (var gri = 0; gri < finalGroups.length; gri++) {
      var grp = finalGroups[gri];

      if (grp.length === 1) {
        var singleChain = chains[sigs[grp[0]].chainIdx];
        if (singleChain.ids.length >= chainMinLen) {
          newChains.push(singleChain);
        }
        continue;
      }

      // Determine flip status relative to first chain in group
      var refSig = sigs[grp[0]];
      var fragInfos = [];

      for (var gci = 0; gci < grp.length; gci++) {
        var gSig = sigs[grp[gci]];
        var gChain = chains[gSig.chainIdx];
        var gIds = gChain.ids;
        var sameDist2 = (_labDist(refSig.avgLeft, gSig.avgLeft) +
                        _labDist(refSig.avgRight, gSig.avgRight)) * 0.5;
        var flipDist2 = (_labDist(refSig.avgLeft, gSig.avgRight) +
                        _labDist(refSig.avgRight, gSig.avgLeft)) * 0.5;
        var isFlipped = flipDist2 < sameDist2;

        // Get the oriented token array for this fragment
        var oriented = isFlipped ? gIds.slice().reverse() : gIds.slice();
        var oFirst = tokenById[oriented[0]];
        var oLast = tokenById[oriented[oriented.length - 1]];
        if (!oFirst || !oLast) continue;

        fragInfos.push({
          ids: oriented,
          startTok: oFirst,
          endTok: oLast
        });
      }

      if (fragInfos.length === 0) continue;

      // Compute group centroid from ALL tokens
      var gcx = 0, gcy = 0, gtn = 0;
      for (var gti = 0; gti < fragInfos.length; gti++) {
        var gtIds = fragInfos[gti].ids;
        for (var gtj = 0; gtj < gtIds.length; gtj++) {
          var gt = tokenById[gtIds[gtj]];
          if (gt) { gcx += gt.x; gcy += gt.y; gtn++; }
        }
      }
      if (gtn > 0) { gcx /= gtn; gcy /= gtn; }

      // Find starting fragment: endpoint farthest from centroid
      var bestStart = 0, bestDist2 = -1, bestIsEnd = false;
      for (var bsi = 0; bsi < fragInfos.length; bsi++) {
        var bFrag = fragInfos[bsi];
        var bsd2 = (bFrag.startTok.x - gcx) * (bFrag.startTok.x - gcx) +
                   (bFrag.startTok.y - gcy) * (bFrag.startTok.y - gcy);
        var bed2 = (bFrag.endTok.x - gcx) * (bFrag.endTok.x - gcx) +
                   (bFrag.endTok.y - gcy) * (bFrag.endTok.y - gcy);
        if (bsd2 > bestDist2) { bestDist2 = bsd2; bestStart = bsi; bestIsEnd = false; }
        if (bed2 > bestDist2) { bestDist2 = bed2; bestStart = bsi; bestIsEnd = true; }
      }

      // Greedy nearest-endpoint walk to order all fragments
      var ordered = [];
      var used = {};

      var firstFrag = fragInfos[bestStart];
      var firstIds = bestIsEnd ? firstFrag.ids.slice().reverse() : firstFrag.ids.slice();
      ordered.push(firstIds);
      used[bestStart] = true;

      for (var wi = 1; wi < fragInfos.length; wi++) {
        var curIds = ordered[ordered.length - 1];
        var curEnd = tokenById[curIds[curIds.length - 1]];
        if (!curEnd) break;

        var bestNext = -1, bestNextD2 = Infinity, bestNextReverse = false;

        for (var wj = 0; wj < fragInfos.length; wj++) {
          if (used[wj]) continue;
          var wFrag = fragInfos[wj];

          // Distance to this fragment's start
          var wds = (wFrag.startTok.x - curEnd.x) * (wFrag.startTok.x - curEnd.x) +
                    (wFrag.startTok.y - curEnd.y) * (wFrag.startTok.y - curEnd.y);
          // Distance to this fragment's end (would reverse)
          var wde = (wFrag.endTok.x - curEnd.x) * (wFrag.endTok.x - curEnd.x) +
                    (wFrag.endTok.y - curEnd.y) * (wFrag.endTok.y - curEnd.y);

          var wMinD = Math.min(wds, wde);
          if (wMinD < bestNextD2) {
            bestNextD2 = wMinD;
            bestNext = wj;
            bestNextReverse = wde < wds;
          }
        }

        if (bestNext < 0) break;

        var nextIds = bestNextReverse
          ? fragInfos[bestNext].ids.slice().reverse()
          : fragInfos[bestNext].ids.slice();
        ordered.push(nextIds);
        used[bestNext] = true;
      }

      // Concatenate all ordered fragments into one unified chain
      var unified = [];
      for (var ui = 0; ui < ordered.length; ui++) {
        var uIds = ordered[ui];
        for (var uj = 0; uj < uIds.length; uj++) {
          unified.push(uIds[uj]);
        }

        // Add adjacency link at the junction between this fragment and the next
        if (ui + 1 < ordered.length) {
          var juncA = uIds[uIds.length - 1];
          var juncB = ordered[ui + 1][0];
          if (juncA !== juncB) {
            var alreadyLinked = false;
            var adjA = adjacency[juncA];
            if (adjA) {
              for (var jli = 0; jli < adjA.length; jli++) {
                if (adjA[jli] === juncB) { alreadyLinked = true; break; }
              }
            }
            if (!alreadyLinked) {
              adjacency[juncA].push(juncB);
              adjacency[juncB].push(juncA);
            }
          }
        }
      }

      if (unified.length >= chainMinLen) {
        newChains.push({ ids: unified, ordered: true });
      }
    }

    // ── Step 6: Re-detect loops on unified chains ──
    // After consolidation, unified chains may now have endpoints that are
    // close enough to close into loops.
    var sideColorGateLoop = sideColorGate;
    for (var nli = 0; nli < newChains.length; nli++) {
      var nIds = newChains[nli].ids;
      if (nIds.length < 6) continue;

      var nFirst = tokenById[nIds[0]];
      var nLast = tokenById[nIds[nIds.length - 1]];
      if (!nFirst || !nLast) continue;

      var ldx = nFirst.x - nLast.x, ldy = nFirst.y - nLast.y;
      var loopDist2 = ldx * ldx + ldy * ldy;
      var closureR = cfg.closureMaxGapPx || 50;
      if (loopDist2 > closureR * closureR) continue;

      // Side-color check
      var llD = _labDist(nFirst.leftLab, nLast.leftLab);
      var rrD = _labDist(nFirst.rightLab, nLast.rightLab);
      var lrD = _labDist(nFirst.leftLab, nLast.rightLab);
      var rlD = _labDist(nFirst.rightLab, nLast.leftLab);
      var bestCD = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
      if (bestCD > sideColorGateLoop) continue;

      // Direction check: at least one end should face the other
      var endDir = _estimateChainEndDir(nIds, false, tokenById);
      var startDir = _estimateChainEndDir(nIds, true, tokenById);
      if (endDir && startDir) {
        var loopDist = Math.sqrt(loopDist2);
        if (loopDist > 0.5) {
          var gapX = ldx / loopDist, gapY = ldy / loopDist;
          var e2f = endDir[0] * gapX + endDir[1] * gapY;
          var f2e = startDir[0] * (-gapX) + startDir[1] * (-gapY);
          if (e2f < 0.15 && f2e < 0.15) continue;
        }
      }

      // Close the loop
      var nFirstId = nIds[0], nLastId = nIds[nIds.length - 1];
      var alreadyClosed = false;
      var adjLast = adjacency[nLastId];
      if (adjLast) {
        for (var acli = 0; acli < adjLast.length; acli++) {
          if (adjLast[acli] === nFirstId) { alreadyClosed = true; break; }
        }
      }
      if (!alreadyClosed) {
        adjacency[nLastId].push(nFirstId);
        adjacency[nFirstId].push(nLastId);
      }
      newLoops.push({ ids: nIds });
    }

    return { chains: newChains, loops: newLoops };
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Boundary coherence salience (Phase 3)
   *
   *  Replaces the old chain-length based salience with a metric
   *  reflecting actual boundary quality:
   *
   *    1. Direction smoothness (30%): how consistently the chain
   *       maintains direction without sharp turns
   *    2. Side consistency (30%): how stable the left/right LAB
   *       identity is throughout the chain
   *    3. Enclosure contribution (20%): tokens in loops get a bonus
   *    4. Chain length (20%): longer chains are structurally stronger
   *
   *  Result: { tokenId → 0..1 }
   * ──────────────────────────────────────────────────────────────────── */
  function _computeBoundaryCoherenceSalience(tokens, chains, adjacency, tokenById, cfg) {
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;

    // Build loop membership
    var inLoop = {};
    for (var ci = 0; ci < chains.length; ci++) {
      var ch = chains[ci];
      var ids = ch.ids;
      if (ids.length < 6) continue;
      var firstTok = tokenById[ids[0]], lastTok = tokenById[ids[ids.length - 1]];
      if (!firstTok || !lastTok) continue;
      // Check if first and last are adjacent (loop)
      var adj = adjacency[ids[0]];
      var isLoop = false;
      for (var ai = 0; ai < adj.length; ai++) {
        if (adj[ai] === ids[ids.length - 1]) { isLoop = true; break; }
      }
      if (isLoop) {
        for (var li = 0; li < ids.length; li++) inLoop[ids[li]] = true;
      }
    }

    // Find max chain length for normalization
    var maxChainLen = 1;
    for (var mci = 0; mci < chains.length; mci++) {
      if (chains[mci].ids.length > maxChainLen) maxChainLen = chains[mci].ids.length;
    }

    // Compute per-chain scores, then assign to tokens
    var salience = {};
    // Default: all tokens start at 0
    for (var ti = 0; ti < tokens.length; ti++) salience[tokens[ti].id] = 0;

    for (var sci = 0; sci < chains.length; sci++) {
      var sids = chains[sci].ids;
      if (sids.length < 2) continue;

      // Direction smoothness: average cos(angle) between consecutive steps
      var dirSmooth = 1.0;
      var dirCount = 0;
      for (var di = 1; di < sids.length - 1; di++) {
        var dPrev = tokenById[sids[di - 1]];
        var dCur = tokenById[sids[di]];
        var dNext = tokenById[sids[di + 1]];
        if (!dPrev || !dCur || !dNext) continue;
        var dx1 = dCur.x - dPrev.x, dy1 = dCur.y - dPrev.y;
        var dx2 = dNext.x - dCur.x, dy2 = dNext.y - dCur.y;
        var m1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        var m2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (m1 > 0.5 && m2 > 0.5) {
          var dDot = (dx1 * dx2 + dy1 * dy2) / (m1 * m2);
          dirSmooth += Math.max(0, dDot); // 1.0 = straight, 0 = perpendicular
          dirCount++;
        }
      }
      if (dirCount > 0) dirSmooth = dirSmooth / (dirCount + 1);

      // Side consistency: check how stable left/right LAB is
      var sideConsist = 1.0;
      if (sids.length >= 4) {
        var refTok = tokenById[sids[0]];
        if (refTok) {
          var driftTotal = 0;
          for (var ssi = 1; ssi < sids.length; ssi++) {
            var ssTok = tokenById[sids[ssi]];
            if (!ssTok) continue;
            var ssD = (_labDist(refTok.leftLab, ssTok.leftLab) +
                      _labDist(refTok.rightLab, ssTok.rightLab)) * 0.5;
            var ssFlip = (_labDist(refTok.leftLab, ssTok.rightLab) +
                         _labDist(refTok.rightLab, ssTok.leftLab)) * 0.5;
            driftTotal += Math.min(ssD, ssFlip);
          }
          var avgDrift = driftTotal / (sids.length - 1);
          sideConsist = Math.max(0, 1.0 - avgDrift / sideColorGate);
        }
      }

      // Enclosure contribution
      var enclosureBonus = 0;
      for (var ei = 0; ei < sids.length; ei++) {
        if (inLoop[sids[ei]]) { enclosureBonus = 1.0; break; }
      }

      // Chain length factor (normalized)
      var lenFactor = Math.min(1.0, sids.length / maxChainLen);

      // Combined salience for this chain
      var chainSalience = 0.30 * dirSmooth + 0.30 * sideConsist +
                          0.20 * enclosureBonus + 0.20 * lenFactor;

      // Assign to all tokens in this chain
      for (var sai = 0; sai < sids.length; sai++) {
        salience[sids[sai]] = Math.max(salience[sids[sai]], chainSalience);
      }
    }

    return salience;
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
    var firstNeis = adjacency[first];
    if (!firstNeis) return false;
    var lastFound = false;
    for (var fi = 0; fi < firstNeis.length; fi++) { if (firstNeis[fi] === last) { lastFound = true; break; } }
    if (!lastFound) return false;
    // Build O(1) membership set — avoids O(n) indexOf inside the degree loop
    var compSet = {};
    for (var k = 0; k < componentIds.length; k++) compSet[componentIds[k]] = true;
    for (var i = 0; i < ordered.length; i++) {
      var deg = 0;
      var neis = adjacency[ordered[i]] || [];
      for (var j = 0; j < neis.length; j++) {
        if (compSet[neis[j]]) deg++;
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
  function _pruneStructuralOutliers(tokens, adjacency, tokenById, cfg, salience) {
    var dirDevMax = cfg.outlierDirDeviationMax != null ? cfg.outlierDirDeviationMax : 0.35;
    var minSupport = Math.max(1, cfg.outlierMinNeighborSupport || 2);
    var pruneTiny = cfg.outlierPruneTinyComponents !== false;
    var tinyMax = Math.max(0, cfg.outlierTinyComponentSize || 1);
    var removed = {};
    var prunedCount = 0;

    // Salience-aware pruning: tokens with high salience are protected.
    // The salience floor determines below which score tokens become prunable.
    var salienceFloor = cfg.saliencePruneFloor != null ? cfg.saliencePruneFloor : 0.12;
    var hasSalience = salience && typeof salience === 'object';

    // ── Pass A: adjacency-based structural mismatch ──
    // Degree-1 tokens are often valid chain endpoints (especially after
    // residual recovery). Use a more lenient threshold for them so that
    // endpoints with reasonable alignment survive. Only tokens that are
    // truly misaligned get pruned.
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var neis = adjacency[t.id] || [];
      if (neis.length >= minSupport) continue;

      // Salience protection: high-salience tokens survive even with
      // low degree.  They represent structurally important tokens that
      // may have been recovered into chains via the residual pass.
      if (hasSalience && (salience[t.id] || 0) >= salienceFloor * 3) continue;

      if (neis.length === 0) {
        // Even isolated tokens are protected if high-salience
        if (hasSalience && (salience[t.id] || 0) >= salienceFloor) continue;
        removed[t.id] = true;
        continue;
      }

      var fit = _tokenNeighborFit(t, neis, tokenById);
      // Degree-1 tokens get 50% more lenient threshold — they are often
      // valid chain endpoints, not outliers.
      // Salience provides additional leniency: high-salience tokens get
      // up to 2x the base threshold.
      var salienceLeniency = 1.0;
      if (hasSalience) {
        salienceLeniency = 1.0 + (salience[t.id] || 0); // 1.0..2.0
      }
      var effectiveDevMax = neis.length === 1 ? dirDevMax * 1.5 * salienceLeniency : dirDevMax * salienceLeniency;
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
        // NOTE: On curves/swirls, consecutive segments naturally have lower
        // dot products. Only flag truly reversed segments (< -0.5) and
        // require both tangent AND spatial mismatch to prune.
        var segDot = (d1x * d2x + d1y * d2y) / (m1 * m2);
        if (segDot < -0.5) { // was -0.3; only flag true reversals, not gentle curves
          // Sharp spatial reversal — this token is a zigzag outlier.
          // But only prune if it also fails tangent consistency by a wide margin.
          // Salience protection: high-salience tokens resist zigzag pruning.
          var curSalience = hasSalience ? (salience[curTok.id] || 0) : 0;
          if (curSalience >= salienceFloor * 3) continue; // protected
          var fitC = _tokenNeighborFit(curTok, adjacency[curTok.id] || [], tokenById);
          var zigzagDevMax = dirDevMax * 0.9 * (1.0 + curSalience);
          if (fitC.dirDev > zigzagDevMax) {
            removed[curTok.id] = true;
          }
        }

        // Also check: token tangent deviates from the local chain trend
        // (prev→next direction), which catches off-trend tokens that happen
        // to be spatially in-line but oriented wrong.
        // NOTE: On tight curves the tangent can legitimately be at a large
        // angle to the prev→next chord. Only prune near-perpendicular cases.
        var trendX = nextTok.x - prevTok.x, trendY = nextTok.y - prevTok.y;
        var trendMag = Math.sqrt(trendX * trendX + trendY * trendY);
        if (trendMag > 0.5) {
          var trendDot = Math.abs(curTok.tangentX * trendX + curTok.tangentY * trendY) / trendMag;
          // trendDot < 0.15 means tangent is truly perpendicular to local flow
          // Salience lowers the threshold further for important tokens
          var perpThresh = 0.15;
          if (hasSalience) perpThresh = 0.15 * (1.0 - (salience[curTok.id] || 0) * 0.5);
          if (trendDot < perpThresh) {
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
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;

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

            // ── Side color HARD GATE (same as Pass 1 linking) ──
            // Endpoints from different boundaries must not bridge.
            var llD = _labDist(tokA.leftLab, tokB.leftLab);
            var rrD = _labDist(tokA.rightLab, tokB.rightLab);
            var lrD = _labDist(tokA.leftLab, tokB.rightLab);
            var rlD = _labDist(tokA.rightLab, tokB.leftLab);
            var bestColorDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
            if (bestColorDist > sideColorGate) continue;

            var colorScore = Math.max(0, 1.0 - bestColorDist / (bridgeSideTol * 2));
            var gapScore = 1.0 - (gap / maxGap);

            // Balanced: direction 35%, trend 25%, gap 20%, color 20%
            var combinedScore = dirScore * 0.35 + trendScore * 0.25 +
                                gapScore * 0.20 + colorScore * 0.20;

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
   *
   * DIRECTION-COHERENT WALKING (architectural fix):
   *
   * The previous implementation used pure nearest-neighbor walking, which
   * caused catastrophic cross-boundary interleaving: when a component
   * contained tokens from multiple boundaries (e.g., a grid border +
   * nearby object edges), the walk would meander between them based
   * solely on proximity. This consumed object-boundary tokens into the
   * grid-line chain, preventing them from being recovered as separate chains.
   *
   * The new implementation scores neighbors by:
   *   1. Direction coherence: does stepping to this neighbor continue the
   *      chain's current heading? (50% weight when direction is known)
   *   2. Tangent alignment: does the neighbor's tangent match the current
   *      token's tangent? (30% weight) — tokens on the same boundary
   *      have similar tangents
   *   3. Proximity: closer is still preferred, but not dominant (20% weight)
   *
   * For the first step (no direction history), the walk uses the start
   * token's tangent to determine preferred direction: it prefers neighbors
   * that lie along the tangent axis (i.e., along the boundary).
   *
   * Effect: The walk stays on ONE boundary. When it reaches a junction
   * where another boundary crosses, it prefers to continue straight rather
   * than detour. Tokens on other boundaries become residuals, which
   * _recoverResidualChains picks up as separate chains.
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

    // ── Direction-coherent forward walk ──
    var ordered = [start];
    var used = {};
    used[start] = true;

    while (ordered.length < compIds.length) {
      var last = ordered[ordered.length - 1];
      var lastTok = tokenById[last];
      if (!lastTok) break;

      // Compute direction estimate from last 2 tokens
      var hasDirEst = false;
      var estDirX = 0, estDirY = 0;
      if (ordered.length >= 2) {
        var prevId = ordered[ordered.length - 2];
        var prevTok2 = tokenById[prevId];
        if (prevTok2) {
          var _edx = lastTok.x - prevTok2.x, _edy = lastTok.y - prevTok2.y;
          var _emag = Math.sqrt(_edx * _edx + _edy * _edy);
          if (_emag > 0.5) {
            estDirX = _edx / _emag;
            estDirY = _edy / _emag;
            hasDirEst = true;
          }
        }
      }

      var best = -1, bestScore = -Infinity;
      var neis2 = adjacency[last];
      for (var n = 0; n < neis2.length; n++) {
        var nid = neis2[n];
        if (!inComp[nid] || used[nid]) continue;
        var nt = tokenById[nid];
        if (!nt) continue;
        var _dx = nt.x - lastTok.x, _dy = nt.y - lastTok.y;
        var _d2 = _dx * _dx + _dy * _dy;
        if (_d2 < 0.01) continue;
        var _d = Math.sqrt(_d2);

        // Proximity: inverse distance, closer is better
        var proxScore = 1.0 / (1.0 + _d);
        // Tangent alignment between current and candidate tokens
        var tangDot = Math.abs(lastTok.tangentX * nt.tangentX + lastTok.tangentY * nt.tangentY);

        var score;
        if (hasDirEst) {
          // Direction coherence: does the step follow the chain's heading?
          // connDot ranges from -1 (backward) to +1 (forward)
          var connDot = (_dx * estDirX + _dy * estDirY) / _d;
          // Map to [0, 1]: forward = 1.0, perpendicular = 0.5, backward = 0.0
          var connScore = (connDot + 1.0) * 0.5;
          // Direction coherence dominates: keeps walk on current boundary
          score = connScore * 0.50 + tangDot * 0.30 + proxScore * 0.20;
        } else {
          // No direction yet: use tangent to determine initial heading.
          // Prefer neighbors that lie along the tangent direction (along boundary).
          var connTangDot = Math.abs(lastTok.tangentX * _dx / _d + lastTok.tangentY * _dy / _d);
          score = connTangDot * 0.40 + tangDot * 0.35 + proxScore * 0.25;
        }

        if (score > bestScore) { bestScore = score; best = nid; }
      }

      if (best < 0) break;
      ordered.push(best);
      used[best] = true;
    }

    // ── Direction-coherent backward walk ──
    // Same direction-aware logic, starting from ordered[0] heading away
    // from ordered[1] (i.e., the reverse direction of the forward walk).
    if (ordered.length < compIds.length) {
      var backward = [];
      var bwCur = ordered[0];
      // Initial backward direction: from ordered[1] → ordered[0]
      var bwHasDir = ordered.length >= 2;
      var bwDirX = 0, bwDirY = 0;
      if (bwHasDir) {
        var bwRefTok = tokenById[ordered[1]];
        var bwStartTok = tokenById[ordered[0]];
        if (bwRefTok && bwStartTok) {
          var _bwdx = bwStartTok.x - bwRefTok.x, _bwdy = bwStartTok.y - bwRefTok.y;
          var _bwmag = Math.sqrt(_bwdx * _bwdx + _bwdy * _bwdy);
          if (_bwmag > 0.5) {
            bwDirX = _bwdx / _bwmag;
            bwDirY = _bwdy / _bwmag;
          } else { bwHasDir = false; }
        } else { bwHasDir = false; }
      }

      while (ordered.length + backward.length < compIds.length) {
        var bwTok = tokenById[bwCur];
        if (!bwTok) break;
        var bwBest = -1, bwBestScore = -Infinity;
        var bwNeis = adjacency[bwCur];
        for (var bn = 0; bn < bwNeis.length; bn++) {
          var bnid = bwNeis[bn];
          if (!inComp[bnid] || used[bnid]) continue;
          var bnt = tokenById[bnid];
          if (!bnt) continue;
          var _bdx = bnt.x - bwTok.x, _bdy = bnt.y - bwTok.y;
          var _bd2 = _bdx * _bdx + _bdy * _bdy;
          if (_bd2 < 0.01) continue;
          var _bd = Math.sqrt(_bd2);

          var bProx = 1.0 / (1.0 + _bd);
          var bTang = Math.abs(bwTok.tangentX * bnt.tangentX + bwTok.tangentY * bnt.tangentY);

          var bScore;
          if (bwHasDir) {
            var bConn = (_bdx * bwDirX + _bdy * bwDirY) / _bd;
            var bConnS = (bConn + 1.0) * 0.5;
            bScore = bConnS * 0.50 + bTang * 0.30 + bProx * 0.20;
          } else {
            var bConnT = Math.abs(bwTok.tangentX * _bdx / _bd + bwTok.tangentY * _bdy / _bd);
            bScore = bConnT * 0.40 + bTang * 0.35 + bProx * 0.25;
          }

          if (bScore > bwBestScore) { bwBestScore = bScore; bwBest = bnid; }
        }
        if (bwBest < 0) break;
        backward.push(bwBest);
        used[bwBest] = true;

        // Update backward direction estimate
        var bwNewTok = tokenById[bwBest];
        if (bwNewTok) {
          var _bwUdx = bwNewTok.x - bwTok.x, _bwUdy = bwNewTok.y - bwTok.y;
          var _bwUmag = Math.sqrt(_bwUdx * _bwUdx + _bwUdy * _bwUdy);
          if (_bwUmag > 0.5) {
            bwDirX = _bwUdx / _bwUmag;
            bwDirY = _bwUdy / _bwUmag;
            bwHasDir = true;
          }
        }
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

  function _extendChainEndpoints(chains, adjacency, tokenById, cfg, _diag) {
    var maxDist = cfg.chainExtensionMaxDist || 40;
    var dirMin = cfg.chainExtensionDirAlign || 0.50;
    var colorTol = cfg.chainExtensionColorTol || 40;
    var trendWindow = cfg.chainExtensionTrendWindow || 4;
    var maxDirDrift = cfg.chainExtensionMaxDirDrift || 0.40;
    var corridorHW = 12; // was 8; widened to capture candidates on curved boundaries
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;

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

    // Precompute per-token density scores used by _lookaheadProbe density bonus.
    // Done once here (O(N)) rather than per-candidate inside the beam search inner loop
    // (which would be O(candidates × beamWidth × depth × 25 × k) per extension step).
    // Approximation: computed before any chain extension begins, so in-chain tokens
    // are not excluded — but since we saturate at 5 neighbors and chains are a small
    // fraction of total tokens, the error is negligible in practice.
    var densityCache = null;
    var _dcDensityRadius = lookaheadCfg ? (lookaheadCfg.densityRadius || 0) : 0;
    var _dcDensityWeight = lookaheadCfg ? (lookaheadCfg.densityWeight || 0) : 0;
    if (_dcDensityWeight > 0 && _dcDensityRadius > 0) {
      densityCache = {};
      var _dcR2 = _dcDensityRadius * _dcDensityRadius;
      var _dcCellR = Math.ceil(_dcDensityRadius / extCellSize);
      for (var _dcKey in tokenById) {
        var _dcTok = tokenById[_dcKey];
        var _dcCx = (_dcTok.x / extCellSize) | 0;
        var _dcCy = (_dcTok.y / extCellSize) | 0;
        var _dcCount = 0;
        outerDens: for (var _dcDy = -_dcCellR; _dcDy <= _dcCellR; _dcDy++) {
          for (var _dcDx = -_dcCellR; _dcDx <= _dcCellR; _dcDx++) {
            var _dcBkt = extGrid[(_dcCx + _dcDx) + ',' + (_dcCy + _dcDy)];
            if (!_dcBkt) continue;
            for (var _dcBi = 0; _dcBi < _dcBkt.length; _dcBi++) {
              var _dcNbr = _dcBkt[_dcBi];
              if (_dcNbr.id === _dcTok.id) continue;
              var _dcDxr = _dcNbr.x - _dcTok.x, _dcDyr = _dcNbr.y - _dcTok.y;
              if (_dcDxr * _dcDxr + _dcDyr * _dcDyr <= _dcR2) {
                _dcCount++;
                if (_dcCount >= 5) break outerDens; // saturate early
              }
            }
          }
        }
        densityCache[_dcTok.id] = _dcCount / 5.0; // pre-normalized 0..1
      }
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

      var _extBefore = ids.length;
      _tokenExtend(ids, false, tokenById, adjacency,
                   extGrid, extCellSize, tokenToChain, chains, ci,
                   maxDist, dirMin, colorTol, corridorHW, trendWindow, maxDirDrift,
                   sideColorGate,
                   microchainCfg, lookaheadCfg, xyTrendCfg, densityCache, _diag);
      _tokenExtend(ids, true, tokenById, adjacency,
                   extGrid, extCellSize, tokenToChain, chains, ci,
                   maxDist, dirMin, colorTol, corridorHW, trendWindow, maxDirDrift,
                   sideColorGate,
                   microchainCfg, lookaheadCfg, xyTrendCfg, densityCache, _diag);
      if (ids.length > _extBefore) {
        _diag.extension_chainsExtended++;
        _diag.extension_totalStepsAdded += (ids.length - _extBefore);
      }
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
                        sideColorGate,
                        microchainCfg, lookaheadCfg, xyTrendCfg, densityCache, _diag) {
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
    var baseUpdateInterval = 2; // was 3; re-anchor more often so curves track smoothly

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
    var maxExtensions = 50; // was 15; increased so chains can follow full circle/swirl boundaries

    while (extensionCount < maxExtensions) {
      extensionCount++;

      // Search for candidate tokens ahead of the endpoint using a bounding-box
      // cell scan.  Each grid cell is visited at most once (no duplicate tokens),
      // so no deduplication step is needed.  The per-token corridor check below
      // still filters out tokens outside the actual directional search window.
      var candidates = [];

      // Bounding box of the search corridor rectangle (origin-relative corners):
      //   forward end:  (dirX*maxDist, dirY*maxDist)
      //   perp offsets: ±(perpX*corridorHW, perpY*corridorHW)
      // minX/maxX/minY/maxY encompass all four rectangle corners.
      var _fwdX = dirX * maxDist, _fwdY = dirY * maxDist;
      var _pOffX = Math.abs(perpX * corridorHW), _pOffY = Math.abs(perpY * corridorHW);
      var _bbMinX = Math.min(0, _fwdX) - _pOffX + endTok.x;
      var _bbMaxX = Math.max(0, _fwdX) + _pOffX + endTok.x;
      var _bbMinY = Math.min(0, _fwdY) - _pOffY + endTok.y;
      var _bbMaxY = Math.max(0, _fwdY) + _pOffY + endTok.y;
      var _cxMin = ((_bbMinX / extCellSize) | 0) - 1;
      var _cxMax = ((_bbMaxX / extCellSize) | 0) + 1;
      var _cyMin = ((_bbMinY / extCellSize) | 0) - 1;
      var _cyMax = ((_bbMaxY / extCellSize) | 0) + 1;

      for (var _cy = _cyMin; _cy <= _cyMax; _cy++) {
        for (var _cx = _cxMin; _cx <= _cxMax; _cx++) {
          var _bucket = extGrid[_cx + ',' + _cy];
          if (!_bucket) continue;
          for (var _bi = 0; _bi < _bucket.length; _bi++) {
            var cand = _bucket[_bi];
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

            // Sided color compatibility — HARD GATE then scoring.
            // Extension must not cross boundary identity, same as Pass 1.
            var llD = _labDist(endTok.leftLab, cand.leftLab);
            var rrD = _labDist(endTok.rightLab, cand.rightLab);
            var lrD = _labDist(endTok.leftLab, cand.rightLab);
            var rlD = _labDist(endTok.rightLab, cand.leftLab);
            var cDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
            if (cDist > sideColorGate) continue; // hard gate: same boundary only
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

      if (candidates.length === 0) { if (_diag) _diag.extension_noCandidates++; break; }

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
                                   laBeamWidth, laDensityRadius, laDensityWeight,
                                   densityCache);

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
            // Only rescue within a bounded overshoot zone (up to 2.5x threshold).
            // Beyond that, the step is too divergent regardless of future.
            // Was 2.0x — increased to 2.5x so curve transitions with valid futures survive.
            if (driftFromBase <= effectiveDriftMax * 2.5) {
              rescued = true;
              if (_diag) _diag.extension_driftRescues++;
            }
          }
          if (!rescued) { if (_diag) _diag.extension_driftKills++; break; }
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
                           beamWidth, densityRadius, densityWeight, densityCache) {
    beamWidth = beamWidth || 1;
    densityRadius = densityRadius || 0;
    densityWeight = densityWeight || 0;
    // densityCache: precomputed per-token density scores (O(1) lookup).
    // When provided, replaces the per-candidate grid scan for density bonus.

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

        // ── Collect all strict-valid candidates from this beam position ──
        // Bounding-box cell scan: each grid cell visited at most once, eliminating
        // duplicate token evaluations from the old stepped directional scan.
        var stepCands = [];

        var _bmPerpX = -bm.curDirY, _bmPerpY = bm.curDirX;
        var _bmFwdX = bm.curDirX * maxDist, _bmFwdY = bm.curDirY * maxDist;
        var _bmPOffX = Math.abs(_bmPerpX * corridorHW), _bmPOffY = Math.abs(_bmPerpY * corridorHW);
        var _bmBBMinX = Math.min(0, _bmFwdX) - _bmPOffX + bm.curTok.x;
        var _bmBBMaxX = Math.max(0, _bmFwdX) + _bmPOffX + bm.curTok.x;
        var _bmBBMinY = Math.min(0, _bmFwdY) - _bmPOffY + bm.curTok.y;
        var _bmBBMaxY = Math.max(0, _bmFwdY) + _bmPOffY + bm.curTok.y;
        var _bmCxMin = ((_bmBBMinX / extCellSize) | 0) - 1;
        var _bmCxMax = ((_bmBBMaxX / extCellSize) | 0) + 1;
        var _bmCyMin = ((_bmBBMinY / extCellSize) | 0) - 1;
        var _bmCyMax = ((_bmBBMaxY / extCellSize) | 0) + 1;

        for (var _bmCy = _bmCyMin; _bmCy <= _bmCyMax; _bmCy++) {
          for (var _bmCx = _bmCxMin; _bmCx <= _bmCxMax; _bmCx++) {
            var bucket = extGrid[_bmCx + ',' + _bmCy];
            if (!bucket) continue;
            for (var bki = 0; bki < bucket.length; bki++) {
              var cand = bucket[bki];
              if (inChain[cand.id] || bm.probeUsed[cand.id]) continue;

              var relX = cand.x - bm.curTok.x;
              var relY = cand.y - bm.curTok.y;
              var along = relX * bm.curDirX + relY * bm.curDirY;
              var across = Math.abs(relX * _bmPerpX + relY * _bmPerpY);

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

              // ── Density bonus: structural richness ahead ──
              // Uses precomputed densityCache (O(1)) instead of an inline grid scan
              // (previously O(25 × k) per candidate — the dominant inner-loop cost).
              if (densityWeight > 0) {
                score += densityWeight * (densityCache ? (densityCache[cand.id] || 0) : 0);
              }

              stepCands.push({ tok: cand, score: score, along: along });
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
    var sideColorGate = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;

    // Build set of loop token IDs (chains already detected as loops)
    var loopSet = {};
    for (var li = 0; li < loops.length; li++) {
      var lids = loops[li].ids;
      for (var lj = 0; lj < lids.length; lj++) loopSet[lids[lj]] = true;
    }

    var closureCount = 0;
    var maxGap2 = maxGap * maxGap;

    // Collect all candidate endpoints (first/last token of each qualifying chain)
    // with their outward trend direction.  Each endpoint carries a sequential idx
    // used to ensure each pair is evaluated once in Pass B.
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

      endpoints.push({ tok: firstTok, chainIdx: ei, isFirst: true,  trendX: ft[0], trendY: ft[1], idx: endpoints.length });
      endpoints.push({ tok: lastTok,  chainIdx: ei, isFirst: false, trendX: lt[0], trendY: lt[1], idx: endpoints.length });
    }

    // Spatial index for Pass B — converts O(E²) to O(E × k).
    // Cell size = maxGap+1 ensures a ±1 cell scan covers all pairs within maxGap.
    var _clCellSize = maxGap + 1;
    var _clGrid = {};
    for (var _clGi = 0; _clGi < endpoints.length; _clGi++) {
      var _clEp = endpoints[_clGi];
      var _clGx = (_clEp.tok.x / _clCellSize) | 0;
      var _clGy = (_clEp.tok.y / _clCellSize) | 0;
      var _clKey = _clGx + ',' + _clGy;
      if (!_clGrid[_clKey]) _clGrid[_clKey] = [];
      _clGrid[_clKey].push(_clEp);
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

      // Color: side color hard gate (same as Pass 1 linking)
      var llD = _labDist(tokA.leftLab,  tokZ.leftLab);
      var rrD = _labDist(tokA.rightLab, tokZ.rightLab);
      var lrD = _labDist(tokA.leftLab,  tokZ.rightLab);
      var rlD = _labDist(tokA.rightLab, tokZ.leftLab);
      var bestColor = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
      if (bestColor > sideColorGate) continue; // hard gate: same boundary only

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
    // Uses spatial grid to scan only endpoints within maxGap (O(E) vs old O(E²)).
    for (var pi2 = 0; pi2 < endpoints.length; pi2++) {
      var eA = endpoints[pi2];
      var _clAgx = (eA.tok.x / _clCellSize) | 0;
      var _clAgy = (eA.tok.y / _clCellSize) | 0;
      for (var _clDy = -1; _clDy <= 1; _clDy++) {
        for (var _clDx = -1; _clDx <= 1; _clDx++) {
          var _clCell = _clGrid[(_clAgx + _clDx) + ',' + (_clAgy + _clDy)];
          if (!_clCell) continue;
          for (var _clCi = 0; _clCi < _clCell.length; _clCi++) {
            var eB = _clCell[_clCi];
            if (eB.idx <= eA.idx) continue; // process each pair once; skip self
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

            // Color: side color hard gate (same as Pass 1 linking)
            var cllD = _labDist(tA.leftLab,  tB.leftLab);
            var crrD = _labDist(tA.rightLab, tB.rightLab);
            var clrD = _labDist(tA.leftLab,  tB.rightLab);
            var crlD = _labDist(tA.rightLab, tB.leftLab);
            var cBestColor = Math.min((cllD + crrD) * 0.5, (clrD + crlD) * 0.5);
            if (cBestColor > sideColorGate) continue; // hard gate: same boundary only

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
          } // _clCi
        } // _clDx
      } // _clDy
    } // pi2

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
   *  Rescue Linking Pass
   *
   *  THE FUNDAMENTAL PROBLEM: After Pass 1's strict gates, some image
   *  regions have ZERO chains (all tokens are degree-0 orphans).
   *  Every subsequent Stage D mechanism (extension, bridge, closure,
   *  residual recovery) requires existing chains to operate on.
   *  They cannot create chains from scratch.
   *
   *  This pass fixes that by linking orphans to OTHER orphans.
   *
   *  At intersections/corners of overlapping shapes, tokens fail
   *  Pass 1 because:
   *    1. Nearby tokens are on DIFFERENT boundaries → side-color gate
   *       correctly rejects them
   *    2. Same-boundary tokens are farther apart (interleaved with
   *       other-boundary tokens) → beyond base/forward radius
   *    3. Corner tokens have noisy tangent estimates → direction gates
   *       reject them
   *
   *  Rescue linking addresses this by:
   *    - Using a wider search radius (2× forward radius)
   *    - Relaxing the direction threshold (0.12 vs 0.55)
   *    - MAINTAINING the side-color hard gate (cross-boundary safety)
   *    - Using side-color identity as the primary matching signal
   *    - Only targeting degree-0 tokens (doesn't disturb existing links)
   *
   *  The output is "seed chains" — small groups of rescued tokens that
   *  extension/bridge/closure can then grow into full chains.
   *
   *  Runs iteratively: each pass creates new links, then the next pass
   *  can link newly-linked tokens to other nearby tokens.
   * ================================================================== */

  function _rescueLinkingPass(tokens, adjacency, tokenById, grid, cellSize, cfg, _diag) {
    var rescueRadius   = cfg.rescueLinkingRadius   || 40;
    var rescueDirMin   = cfg.rescueLinkingDirMin    != null ? cfg.rescueLinkingDirMin : 0.12;
    var rescueScoreMin = cfg.rescueLinkingScoreMin  != null ? cfg.rescueLinkingScoreMin : 0.15;
    var sideColorGate  = cfg.graphSideColorGate     != null ? cfg.graphSideColorGate : 55;
    var maxPasses      = cfg.rescueLinkingMaxPasses  || 3;
    var rescueR2       = rescueRadius * rescueRadius;

    // Build rescue spatial grid with cell size matching rescue radius
    var rCellSize = rescueRadius + 1;
    var rGrid = {};
    for (var gi = 0; gi < tokens.length; gi++) {
      var gt = tokens[gi];
      var rk = ((gt.x / rCellSize) | 0) + ',' + ((gt.y / rCellSize) | 0);
      if (!rGrid[rk]) rGrid[rk] = [];
      rGrid[rk].push(gt);
    }

    var totalRescueLinks = 0;

    for (var pass = 0; pass < maxPasses; pass++) {
      var passLinks = 0;

      // Collect current orphans (degree 0)
      var orphans = [];
      for (var oi = 0; oi < tokens.length; oi++) {
        if ((adjacency[tokens[oi].id] || []).length === 0) {
          orphans.push(tokens[oi]);
        }
      }
      if (orphans.length === 0) break;

      // Sort orphans by confidence descending — most reliable tokens
      // get rescued first, seeding the strongest possible structure.
      orphans.sort(function(a, b) { return b.confidence - a.confidence; });

      for (var ri = 0; ri < orphans.length; ri++) {
        var orphan = orphans[ri];
        // Skip if this orphan already gained links during this pass
        if ((adjacency[orphan.id] || []).length > 0) continue;

        var ogx = (orphan.x / rCellSize) | 0;
        var ogy = (orphan.y / rCellSize) | 0;

        // Collect all rescue-compatible candidates within rescue radius.
        // We search for ANY token (orphan or not) that shares boundary
        // identity.  This allows orphans near the periphery of existing
        // chains to attach directly, not just orphan-to-orphan.
        var bestTarget = null;
        var bestScore = -1;

        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var bucket = rGrid[(ogx + dx) + ',' + (ogy + dy)];
            if (!bucket) continue;

            for (var bi = 0; bi < bucket.length; bi++) {
              var cand = bucket[bi];
              if (cand.id === orphan.id) continue;

              var ddx = cand.x - orphan.x, ddy = cand.y - orphan.y;
              var dist2 = ddx * ddx + ddy * ddy;
              if (dist2 > rescueR2 || dist2 < 1) continue;
              var dist = Math.sqrt(dist2);

              // ── Side-color HARD GATE (non-negotiable) ──
              // This is the only gate that MUST remain strict: it prevents
              // cross-boundary contamination.  Two tokens on different
              // boundaries (different colors on each side) must never link.
              var llD = _labDist(orphan.leftLab, cand.leftLab);
              var rrD = _labDist(orphan.rightLab, cand.rightLab);
              var lrD = _labDist(orphan.leftLab, cand.rightLab);
              var rlD = _labDist(orphan.rightLab, cand.leftLab);
              var bestColorDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
              if (bestColorDist > sideColorGate) continue;

              // ── Direction: relaxed tangent alignment ──
              // At corners, tangent estimation is noisy.  We only reject
              // truly perpendicular token pairs (< 0.12 ≈ 83°).
              var dot = Math.abs(orphan.tangentX * cand.tangentX +
                                 orphan.tangentY * cand.tangentY);
              if (dot < rescueDirMin) continue;

              // ── Connection vector alignment (very relaxed) ──
              // The vector between the two tokens should roughly run along
              // at least one of their tangent directions.  But at corners
              // this can be quite loose, so we just check it's not
              // completely perpendicular to BOTH tangents.
              var invDist = 1.0 / dist;
              var connDotO = Math.abs(orphan.tangentX * ddx + orphan.tangentY * ddy) * invDist;
              var connDotC = Math.abs(cand.tangentX * ddx + cand.tangentY * ddy) * invDist;
              var connAlign = Math.max(connDotO, connDotC); // at least ONE tangent aligns

              // ── Scoring: color identity dominant ──
              // For rescue links, boundary identity (side color match) is
              // the strongest signal.  Direction and geometry are secondary
              // because they're unreliable at corners/intersections.
              var colorScore = Math.max(0, 1.0 - bestColorDist / 40);
              var distScore  = 1.0 - dist / rescueRadius;
              var score = colorScore  * 0.40 +
                          dot         * 0.25 +
                          distScore   * 0.20 +
                          connAlign   * 0.15;

              if (score < rescueScoreMin) continue;

              // Prefer candidates that already have links (attach to
              // existing structure rather than creating isolated pairs)
              var candDeg = (adjacency[cand.id] || []).length;
              var adjBonus = candDeg > 0 ? 0.10 : 0;

              if (score + adjBonus > bestScore) {
                bestScore = score + adjBonus;
                bestTarget = cand;
              }
            }
          }
        }

        if (bestTarget) {
          // Check we're not creating a duplicate link
          var existing = adjacency[orphan.id];
          var alreadyLinked = false;
          for (var eli = 0; eli < existing.length; eli++) {
            if (existing[eli] === bestTarget.id) { alreadyLinked = true; break; }
          }
          if (!alreadyLinked) {
            adjacency[orphan.id].push(bestTarget.id);
            adjacency[bestTarget.id].push(orphan.id);
            passLinks++;
          }
        }
      }

      totalRescueLinks += passLinks;
      if (_diag) _diag.rescue_passesRun++;
      if (passLinks === 0) break; // no progress
    }

    if (_diag) _diag.rescue_linksCreated = totalRescueLinks;
    return { linksCreated: totalRescueLinks };
  }

  /* ==================================================================
   *  Residual Recovery Pass
   *
   *  After multi-pass refinement (extension / bridge / closure), many
   *  tokens may still be unattached — they failed Pass 1's strict gates
   *  and extension's narrow corridor never reached them.
   *
   *  Instead of leaving these permanently orphaned, this pass searches
   *  for compatible attachment points on existing chain BODIES (not just
   *  endpoints).  It uses wider radius and relaxed direction gates while
   *  still enforcing the side-color hard gate to prevent cross-boundary
   *  contamination.
   *
   *  Tokens are processed in confidence-descending order so the most
   *  reliable orphans attach first.  Attachment prefers longer chains
   *  (boundary-first: enclosing structure claims tokens before interior
   *  fragments).
   *
   *  This is the key mechanism that prevents premature token loss:
   *  tokens that couldn't link in Pass 1 due to strict directional
   *  gates may now find compatible chain segments that have grown
   *  closer during extension.
   * ================================================================== */

  function _residualRecoveryPass(tokens, chains, adjacency, tokenById, cfg, _diag) {
    var recoveryRadius = cfg.residualRecoveryRadius || 28;
    var recoveryDirMin = cfg.residualRecoveryDirMin != null ? cfg.residualRecoveryDirMin : 0.20;
    var sideColorGate  = cfg.graphSideColorGate != null ? cfg.graphSideColorGate : 55;
    var maxPasses      = cfg.residualRecoveryMaxPasses || 2;

    // Build set of tokens currently in chains
    var inChain = {};
    for (var ci = 0; ci < chains.length; ci++) {
      var cids = chains[ci].ids;
      for (var cj = 0; cj < cids.length; cj++) inChain[cids[cj]] = true;
    }

    // Build spatial grid of ALL tokens for proximity lookup
    var cellSize = recoveryRadius + 1;
    var grid = {};
    for (var ti = 0; ti < tokens.length; ti++) {
      var t = tokens[ti];
      var key = ((t.x / cellSize) | 0) + ',' + ((t.y / cellSize) | 0);
      if (!grid[key]) grid[key] = [];
      grid[key].push(t);
    }

    // Build chain-length lookup: tokenId → length of its chain
    var tokenChainLen = {};
    for (var cli = 0; cli < chains.length; cli++) {
      var chLen = chains[cli].ids.length;
      var chIds = chains[cli].ids;
      for (var clj = 0; clj < chIds.length; clj++) {
        tokenChainLen[chIds[clj]] = chLen;
      }
    }

    var totalRecovered = 0;

    for (var pass = 0; pass < maxPasses; pass++) {
      // Collect unattached tokens, sorted by confidence descending
      var unattached = [];
      for (var ui = 0; ui < tokens.length; ui++) {
        if (!inChain[tokens[ui].id]) unattached.push(tokens[ui]);
      }
      if (unattached.length === 0) break;

      unattached.sort(function(a, b) { return b.confidence - a.confidence; });

      var passRecovered = 0;

      for (var ri = 0; ri < unattached.length; ri++) {
        var orphan = unattached[ri];
        if (inChain[orphan.id]) continue; // may have been claimed this pass

        var ogx = (orphan.x / cellSize) | 0;
        var ogy = (orphan.y / cellSize) | 0;

        var bestTarget = null;
        var bestScore = -1;
        var bestChainLen = 0;

        // Search nearby cells for chain tokens
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nk = (ogx + dx) + ',' + (ogy + dy);
            var bucket = grid[nk];
            if (!bucket) continue;

            for (var bi = 0; bi < bucket.length; bi++) {
              var cand = bucket[bi];
              if (cand.id === orphan.id) continue;
              if (!inChain[cand.id]) continue; // only attach to chain tokens

              var ddx = cand.x - orphan.x, ddy = cand.y - orphan.y;
              var dist2 = ddx * ddx + ddy * ddy;
              if (dist2 > recoveryRadius * recoveryRadius) continue;
              var dist = Math.sqrt(dist2);
              if (dist < 0.5) continue;

              // Direction: orphan tangent vs candidate tangent
              var dot = Math.abs(orphan.tangentX * cand.tangentX +
                                 orphan.tangentY * cand.tangentY);
              if (dot < recoveryDirMin) continue;

              // Side color HARD GATE (same as Pass 1)
              var llD = _labDist(orphan.leftLab, cand.leftLab);
              var rrD = _labDist(orphan.rightLab, cand.rightLab);
              var lrD = _labDist(orphan.leftLab, cand.rightLab);
              var rlD = _labDist(orphan.rightLab, cand.leftLab);
              var bestColorDist = Math.min((llD + rrD) * 0.5, (lrD + rlD) * 0.5);
              if (bestColorDist > sideColorGate) continue;

              // Connection vector alignment: orphan→cand should run along tangent
              var connDotO = Math.abs(orphan.tangentX * ddx + orphan.tangentY * ddy) / dist;
              var connDotC = Math.abs(cand.tangentX * ddx + cand.tangentY * ddy) / dist;
              var connAlign = (connDotO + connDotC) * 0.5;

              // Scoring: direction + proximity + connection alignment + color
              var distScore = 1.0 - dist / recoveryRadius;
              var colorScore = Math.max(0, 1.0 - bestColorDist / 40);
              var score = dot * 0.30 + distScore * 0.25 + connAlign * 0.25 + colorScore * 0.20;

              // Prefer attachment to longer chains (enclosure priority)
              var candChainLen = tokenChainLen[cand.id] || 1;
              if (score > bestScore ||
                  (score > bestScore - 0.05 && candChainLen > bestChainLen)) {
                bestScore = score;
                bestTarget = cand;
                bestChainLen = candChainLen;
              }
            }
          }
        }

        if (bestTarget && bestScore > 0.20) {
          // Link orphan to target
          adjacency[orphan.id].push(bestTarget.id);
          adjacency[bestTarget.id].push(orphan.id);
          inChain[orphan.id] = true;
          tokenChainLen[orphan.id] = bestChainLen; // inherit chain length for subsequent decisions
          passRecovered++;
        }
      }

      totalRecovered += passRecovered;
      if (_diag) _diag.recovery_passesRun++;
      if (passRecovered === 0) break; // no progress
    }

    if (_diag) {
      _diag.recovery_tokensRecovered = totalRecovered;
      // Count remaining unattached
      var remaining = 0;
      for (var fi = 0; fi < tokens.length; fi++) {
        if (!inChain[tokens[fi].id]) remaining++;
      }
      _diag.recovery_tokensUnrecovered = remaining;
    }

    return { recovered: totalRecovered };
  }

  /* ==================================================================
   *  Token Salience Scoring
   *
   *  Computes a structural importance score (0..1) for every token.
   *  High salience = token participates in coherent enclosing structure.
   *  Low salience = token is isolated, noisy, or trapped inside
   *  already-enclosed regions.
   *
   *  Salience components:
   *    1. Chain membership & length (35%) — tokens in long chains that
   *       form dominant boundaries receive the highest structural score
   *    2. Adjacency degree (20%) — well-connected tokens are more
   *       structurally integrated
   *    3. Directional coherence (20%) — tokens whose tangents agree
   *       with their neighbors are more likely genuine boundary tokens
   *    4. Spatial extent (15%) — tokens in chains that span large
   *       distances (enclosing boundaries) get a bonus
   *    5. Confidence (10%) — original Stage C boundary evidence strength
   *
   *  Salience is used to:
   *    - Protect structurally important tokens from outlier pruning
   *    - Identify interior clutter that can be safely demoted
   *    - Provide downstream stages with structural priority information
   * ================================================================== */

  function _computeTokenSalience(tokens, chains, adjacency, tokenById) {
    var salience = {};  // tokenId → 0..1

    // ── Precompute chain membership and chain stats ──
    var tokenToChainIdx = {};
    var chainStats = [];    // [ { length, spatialExtent } ]
    var maxChainLen = 1;

    for (var ci = 0; ci < chains.length; ci++) {
      var cids = chains[ci].ids;
      var cLen = cids.length;
      if (cLen > maxChainLen) maxChainLen = cLen;

      // Spatial extent: bounding box diagonal of chain tokens
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var cj = 0; cj < cids.length; cj++) {
        tokenToChainIdx[cids[cj]] = ci;
        var ct = tokenById[cids[cj]];
        if (ct) {
          if (ct.x < minX) minX = ct.x;
          if (ct.y < minY) minY = ct.y;
          if (ct.x > maxX) maxX = ct.x;
          if (ct.y > maxY) maxY = ct.y;
        }
      }
      var diag = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY));
      chainStats[ci] = { length: cLen, spatialExtent: diag };
    }

    // Max spatial extent for normalization
    var maxExtent = 1;
    for (var si = 0; si < chainStats.length; si++) {
      if (chainStats[si].spatialExtent > maxExtent) maxExtent = chainStats[si].spatialExtent;
    }

    // ── Score each token ──
    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      var id = tok.id;

      // 1. Chain membership & length (0..1)
      var chainLenScore = 0;
      var chainIdx = tokenToChainIdx[id];
      if (chainIdx != null) {
        chainLenScore = Math.min(1.0, chainStats[chainIdx].length / Math.max(maxChainLen, 1));
      }

      // 2. Adjacency degree (0..1, saturates at 4 neighbors)
      var neis = adjacency[id] || [];
      var degreeScore = Math.min(1.0, neis.length / 4.0);

      // 3. Directional coherence with neighbors (0..1)
      var coherenceScore = 0;
      if (neis.length > 0) {
        var fit = _tokenNeighborFit(tok, neis, tokenById);
        coherenceScore = 1.0 - fit.dirDev; // dirDev 0=perfect → coherence 1.0
      }

      // 4. Spatial extent of containing chain (0..1)
      var extentScore = 0;
      if (chainIdx != null) {
        extentScore = chainStats[chainIdx].spatialExtent / maxExtent;
      }

      // 5. Confidence (0..1, already normalized in Stage C)
      var confScore = Math.min(1.0, tok.confidence || 0);

      // Combined salience
      salience[id] = chainLenScore  * 0.35 +
                     degreeScore    * 0.20 +
                     coherenceScore * 0.20 +
                     extentScore    * 0.15 +
                     confScore      * 0.10;
    }

    return salience;
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
