# Static RUN-mode hierarchical extraction plan

## Current flow map
- **Orchestration**: `extractFieldValue` drives static RUN-mode extraction, including bbox attempts, anchor/landmark assists, keyword triangulation, and final confidence scaling. 【F:invoice-wizard.js†L3009-L3359】
- **BBox attempts**: `attempt` performs snap-to-line, assembles text, fingerprints, and line-count adjustments for the given box (used for base bbox and padded probes). 【F:invoice-wizard.js†L3009-L3103】【F:invoice-wizard.js†L3274-L3279】
- **Line metrics usage**: `adjustConfidenceForLines` uses expected vs observed line counts to scale confidence during RUN. 【F:invoice-wizard.js†L3021-L3033】【F:invoice-wizard.js†L3054-L3069】
- **Line metrics capture (config)**: `extractConfigStatic`/`finalizeConfigValue` store `lineMetrics`, `lineCount`, and `lineHeights` during configuration. 【F:tools/static-field-mode.js†L98-L114】
- **Line metrics reuse (RUN)**: expected line counts pulled from `fieldSpec.lineMetrics`/`lineCount` when computing adjustments. 【F:invoice-wizard.js†L3021-L3033】【F:invoice-wizard.js†L3084-L3085】
- **Triangulation candidate scoring**: `scoreTriangulatedCandidates` builds candidates from nearby lines and evaluates anchor/keyword/distance/fingerprint/totalScore before ranking and preferBest. 【F:invoice-wizard.js†L3132-L3213】
- **Candidate scoring internals**: `evaluateCandidate` within `scoreTriangulatedCandidates` computes distanceScore, keywordScore, anchorScore, fpScore, totalScore, and confidence. 【F:invoice-wizard.js†L3132-L3213】
- **Keyword triangulation inputs**: `KeywordWeighting.triangulateBox` and keyword relations drive `triangulatedBox`/`keywordPrediction` prior to candidate scoring. 【F:invoice-wizard.js†L3234-L3329】

## Hierarchical flow design (static-only)
- **Stage 0 – exact bbox strict**
  - Hook before current padding/triangulation loop inside `extractFieldValue` after `basePx` is computed. Reuse `attempt(basePx)` but add a dedicated check: accept immediately when `fingerprintOk` and `lineDiff === 0` (observed vs expected), bypassing neighbours and pads.
  - Leverage existing `observedLineCount` and expected line count from `fieldSpec.lineMetrics/lineCount` inside `attempt`. Compute `lineDiff = Math.abs(observed - expected||0)` for the decision.

- **Stage 1 – exact bbox relaxed**
  - If Stage 0 fails, reuse the same `attempt(basePx)` result to allow `lineDiff === 1` with stricter fingerprint gating (e.g., require `fingerprintOk` plus cleaned OK). Accept and stop before padding/triangulation.

- **Stage 2 – neighbour single-pass**
  - If both early stages fail, proceed to existing padded attempts + triangulated neighbour scoring, but enforce a single-pass neighbour block:
    - Limit candidates in `scoreTriangulatedCandidates` to distance within `MAX_KEYWORD_RADIUS` (already applied) and add `MAX_STATIC_CANDIDATES` cap when `staticRun` is true.
    - Introduce `lineScore` for static fields inside `evaluateCandidate`, derived from `lineDiff` against configured line count (e.g., 1.0 for match, <1 for near, small for mismatch). Multiply into `totalScore` for static fields only.
    - Track `lineDiff` per candidate and propagate into ranking payload.
    - After sorting once, accept `best` only if `best.totalScore >= MIN_STATIC_ACCEPT_SCORE` **and** (`lineDiff <= 1` or `best.fpOk`). No recursive retries.

## Static vs dynamic gating
- Use `ftype === 'static'`/`staticRun` branches already present in `extractFieldValue` to guard the new hierarchy so dynamic fields keep current behaviour. 【F:invoice-wizard.js†L3015-L3020】【F:invoice-wizard.js†L3274-L3354】

## Proposed code touchpoints
- **New constants**: add to shared scope in `invoice-wizard.js` (near other static constants): `MAX_STATIC_CANDIDATES`, `MIN_STATIC_ACCEPT_SCORE`, `STATIC_LINE_DIFF_WEIGHTS` mapping for lineScore.
- **Stage 0/1 insertion**: inside `extractFieldValue`, after computing `basePx` and before padded `pads` loop, evaluate `initialAttempt` for Stage 0/1 rules and short-circuit when they pass. 【F:invoice-wizard.js†L3234-L3279】
- **Line diff helper**: helper function near `attempt`/scoring utilities to compute `lineDiff` using stored `fieldSpec.lineMetrics.lineCount || fieldSpec.lineCount` and candidate `lineCount`.
- **Stage 2 constraints**: in `scoreTriangulatedCandidates`, apply static-only cap to candidate collection and incorporate `lineScore` in `evaluateCandidate`’s `totalScore` when `staticRun` is true. 【F:invoice-wizard.js†L3132-L3213】
- **Final acceptance rule**: after sorting in `scoreTriangulatedCandidates`, gate static adoption with `MIN_STATIC_ACCEPT_SCORE` and `(lineDiff <= 1 || fpOk)` before `preferBest` triggers replacement. 【F:invoice-wizard.js†L3185-L3213】
- **Debug logging**: extend existing static debug logs around attempts/triangulation to note Stage 0/1 shortcuts and Stage 2 selected candidate with `lineDiff`, `lineScore`, `fpOk`, and `totalScore`.

## Notes on stored line fingerprints
- Configuration already persists line metrics via `extractConfigStatic`/`finalizeConfigValue`, which populate `lineMetrics.lineCount` and `lineCount` on saved field specs. 【F:tools/static-field-mode.js†L98-L114】
- RUN-mode access to expected line counts is centralized in `adjustConfidenceForLines`, which reads `fieldSpec.lineMetrics.lineCount`/`fieldSpec.lineCount` for comparisons. 【F:invoice-wizard.js†L3021-L3033】【F:invoice-wizard.js†L3084-L3085】
- The hierarchical flow should reuse these stored counts for `lineDiff` without introducing new per-field config.
