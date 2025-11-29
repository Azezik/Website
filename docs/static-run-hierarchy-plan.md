# Static RUN-mode hierarchical extraction plan

## Current flow map
- **Orchestration**: `extractFieldValue` drives static RUN-mode extraction, including bbox attempts, anchor/landmark assists, keyword triangulation, and final confidence scaling. 【F:invoice-wizard.js†L2968-L3338】
- **BBox attempts**: `attempt` performs snap-to-line, assembles text, fingerprints, and anchor checks for the given box (used for base bbox and padded probes). 【F:invoice-wizard.js†L2968-L3109】
- **Triangulation candidate scoring**: `scoreTriangulatedCandidates` builds candidates from nearby lines and evaluates anchor/keyword/distance/fingerprint/totalScore before ranking and preferBest. 【F:invoice-wizard.js†L3109-L3189】
- **Candidate scoring internals**: `evaluateCandidate` within `scoreTriangulatedCandidates` computes distanceScore, keywordScore, anchorScore, fpScore, totalScore, and confidence. 【F:invoice-wizard.js†L3109-L3189】
- **Keyword triangulation inputs**: `KeywordWeighting.triangulateBox` and keyword relations drive `triangulatedBox`/`keywordPrediction` prior to candidate scoring. 【F:invoice-wizard.js†L3190-L3285】

## Hierarchical flow design (static-only)
Line-count-based gating has been removed. Static fields now rely on bbox geometry, anchors, keywords, and fingerprints without storing or comparing expected line counts. Padding and triangulation continue to run as before, but candidate scoring no longer factors in observed vs. expected line totals. 【F:invoice-wizard.js†L2968-L3338】

## Static vs dynamic gating
- Use `ftype === 'static'`/`staticRun` branches already present in `extractFieldValue` to guard the new hierarchy so dynamic fields keep current behaviour. 【F:invoice-wizard.js†L3015-L3020】【F:invoice-wizard.js†L3274-L3354】

## Notes on stored line fingerprints
Line metrics are no longer captured or compared for static fields. Saved profiles keep bbox geometry, anchors, landmarks, and keywords without recording expected line totals. 【F:tools/static-field-mode.js†L83-L111】【F:invoice-wizard.js†L2968-L3338】
