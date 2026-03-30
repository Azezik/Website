# WFG3 Diagnostic Audit: Scale and Latent Structure (Stages C/D + Browser Defaults)

## Scope
- `engines/wrokitvision/wfg3/wfg3-stages-ac.js`
- `engines/wrokitvision/wfg3/wfg3-stages-df.js`
- `engines/wrokitvision/wfg3/wfg3-browser-engine.js`

---

## 1) The “Blind Spot” (Scale): hard-coded local windows that enforce micro-vision

### A. Stage C token side sampling is fixed to ~3 px
- `tokenSideSamplePx: 3` in defaults (AC + browser defaults) makes each token read contrast only a few pixels across the boundary normal.
- Where this matters:
  - AC defaults: `tokenSideSamplePx: 3`
  - Browser defaults: `tokenSideSamplePx: 3`
  - `_makeToken(...)` uses this distance for left/right sampling.
- Effect:
  - On large gradients (e.g., sphere), side-difference (`deltaE`) can collapse on low-contrast areas because samples are too close to detect macro luminance trend.

### B. Stage D neighbor linking radius is local (7 px)
- `graphNeighborRadius: 7` (AC/DF defaults + browser defaults).
- Stage D only links if Euclidean distance <= radius.
- Spatial index cell size is `radius + 1`; candidate search checks only neighboring cells and still rejects if outside radius.
- Effect:
  - Chains cannot “jump” over local weak spans longer than ~7 px, so long smooth edges fragment.

### C. Bridge pass extends only to modest gaps (18 px)
- `bridgeMaxGapPx: 18` + endpoint-only bridging.
- Effect:
  - Helps tiny breaks but still too short for large low-evidence arcs/sign contours.
  - Since only endpoints are considered, interior weak sections don’t get rescued unless fragmentation already produced clean endpoints.

### D. Scaffold lattice and suppression windows are micro to meso
- `scaffoldSpacingPx: 12`, `scaffoldSnapRadius: 4`, `scaffoldMinSpacing: 5`, `seedNmsRadiusPx: 3`.
- `_localEvidenceAt` is only 3×3 neighborhood.
- `_snapToLocalPeak` and NMS suppress within small radii.
- Effect:
  - Even “global” scaffold mode remains local around high-response micro-peaks and suppresses nearby hints that might be needed to track faint macro continuity.

### E. Pre-token edge morphology is tiny radius
- `morphRadius: 1` in Stage B close operation.
- Effect:
  - Only 1-px cracks get closed prior to tokenization. Wider low-contrast discontinuities remain broken before Stage C/D can reason about continuity.

---

## 2) The “Confidence Trap”: where weak-but-structural evidence is dropped

### A. Hard token confidence cutoff
- `tokenMinConfidence: 0.05` in defaults.
- In global stride, tile mode, staggered pass, and scaffold mode, tokens are explicitly dropped when `tok.confidence < minConf`.
- Confidence is `min(1, deltaE / tokenConfidenceDeltaEMax)` with `tokenConfidenceDeltaEMax = 40.0`.
- Meaning:
  - Any token with `deltaE < 2` is rejected at 0.05 threshold.
  - This is exactly the kind of “light side” gradient evidence likely to exist on faint continuation zones.

### B. Additional evidence gating in scaffold mode
- `scaffoldEvidenceGateMin: 0.04` hard-gates candidate lattice points before token creation.
- Effect:
  - Weak but geometrically coherent points are filtered before confidence/graph context can help.

### C. Stage B upstream hard thresholds thin weak edges
- Canny thresholds and LAB threshold (`cannyLow`, `cannyHigh`, `labDeltaThreshold`) + binary/morph processing create a hard edge map foundation.
- Stage C tile seeding still mainly starts from `edgeBinary`; “soft” fallback uses fixed `softThresh = 40` on `edgeWeighted`.
- Effect:
  - Weak gradients can be excluded from candidate pools before Stage D can exploit continuity.

### Why strong side succeeds but light side fails
- On the dark/high-contrast side, `deltaE` and edge evidence exceed hard gates, so tokens survive.
- On the light side, local contrast may be below:
  - edge generation thresholds,
  - scaffold evidence gate,
  - or `tokenMinConfidence`.
- Since Stage D does not generate new tokens from chain context, missing faint-side tokens cannot be hallucinated from geometry alone.

---

## 3) Pattern Ambiguity failure: repeating motifs and ambiguous neighbors

### A. Nearest-neighbor greedy ordering in branched/repetitive components
- `_orderChain(...)` picks nearest unvisited neighbor at each step.
- In repeating grids/bars/checkers, multiple neighbors can be equally plausible.
- Greedy nearest walk can choose a branch that dead-ends, then stop early on `best < 0`, returning partial order for a larger component.

### B. Link scoring allows many local ties in repetitive structures
- Stage D pass-1 uses weighted local link score (distance/dir/color) with low hard floors (`dirScore < 0.17` reject, color floor 0.05).
- Repetitive textures often satisfy these similarly across multiple neighbors; ambiguity is unresolved globally.

### C. Chain-level bridge matching only considers endpoint pairs
- In repeated motifs, endpoint pairing can be combinatorial and ambiguous; strict gates (`dirMin`, side consistency, evidence threshold) can reject many plausible bridges.
- Result is many short chains instead of one consistent macro path.

---

## 4) Damping & muting: aggressive pruning/cleanup locations

### Stage C damping points
1. NMS suppression (`_nmsFilter`, `seedNmsRadiusPx`).
2. Per-tile budget clamps (`seedMaxPerTile`, slice top-budget only).
3. Confidence drops (`tok.confidence < minConf`) in all seeding passes.
4. Occupancy suppression in scaffold (`isOccupied` with `scaffoldMinSpacing`).
5. Global cap (`scaffoldMaxTokens`) silently halts adding additional hints.
6. Tile-level trimming in scaffold: if `tileTokenCount > maxPer`, weakest by confidence removed.

### Stage D damping points
1. Local radius filter (`graphNeighborRadius`) rejects longer continuity links.
2. Hard direction floor (`dirScore < 0.17`) and color floor (`colorScore < 0.05` except very close/aligned).
3. Link threshold (`linkScoreThreshold`) drops low-score but potentially structural links.
4. Component pruning: `if (comp.length >= chainMinLength)` keeps only components meeting minimum.
5. Bridge pass has multiple hard gates (gap, direction, side color, evidence, combined score) before acceptance.
6. `_orderChain` break on disconnected choice can terminate ordering early in ambiguous graphs.

### Stage E/F post-graph cleanup (secondary muting)
- Tiny-region merging (`minRegionArea`) can absorb subtle structures into neighbors after boundary fragmentation.
- Morph open on inverted edges with radius 1 and downstream watershed thresholding can smooth away weak structures if boundary graph is already sparse.

---

## Browser-engine defaults that reinforce the same behavior

The browser defaults mirror restrictive settings and make them active by default:
- `tokenSeedingMode: 'tile_min_coverage'`
- `seedTileSizePx: 64`, `seedNmsRadiusPx: 3`, `seedMaxPerTile: 40`
- `seedRefinementEnabled: true` (but still local-neighbor corridor criteria)
- `tokenMinConfidence: 0.05`
- `graphNeighborRadius: 7`, `bridgeMaxGapPx: 18`, `bridgeMinEvidenceScore: 0.25`

This means production behavior is inherently biased toward local high-contrast evidence with modest bridge reach.

---

## Bottom-line diagnosis

The codebase currently embodies a **micro-scale, local-certainty-first philosophy**:
- Local thresholds produce sparse high-confidence tokens.
- Graph links are constrained to short distances and strict gates.
- Ambiguous repeats rely on greedy local decisions.
- Multiple suppression stages remove weak candidates before structural context can rescue them.

This directly explains the observed mismatch: **Stage C can look dense in high-contrast zones, while Stage D fractures macro structures and misses latent low-contrast continuation**.
