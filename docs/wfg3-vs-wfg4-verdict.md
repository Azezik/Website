# WFG3 vs WFG4: Technical Verdict for Current Product Goal

## Product Goal (Restated in engineering terms)
Given a user-selected bbox on a reference document, reliably relocate that same semantic region on visually similar documents (PDFs/screenshots/phone photos), then OCR just that localized region, including repeated block instances.

This is a **registration + local extraction** problem, not a general document-structure understanding problem.

## Blunt Comparison

### WFG3 (custom structural vision stack)
- Strength: expressive and potentially extensible for broad structural reasoning.
- Reality for this goal: wrong center of gravity. Too many moving parts before solving the core operation (stable geometric localization of a known region).
- Failure mode: spends complexity budget on global reasoning when the product requirement is local correspondence and projection.

### WFG4 (OpenCV-centric registration + projection)
- Strength: directly optimizes for the required operation: match, transform, project, refine, OCR.
- Reality for this goal: shortest path to robust results and measurable quality improvements.
- Failure mode: can struggle on ultra-low-texture or severe non-planar warps, but these are tractable with layered fallbacks and local block matching.

## Strategic Judgment

For this specific product target, WFG3 is strategically inferior.

Not “a little less efficient.” Inferior.

Why:
1. **Time-to-value**: WFG3 requires continued tuning of bespoke heuristics; WFG4 ships usable wins faster with known primitives.
2. **Risk**: WFG3 concentrates risk in custom algorithms with uncertain convergence; WFG4 externalizes risk to battle-tested CV methods.
3. **Debuggability**: WFG3 failure attribution is diffuse across pipeline stages; WFG4 failures map to concrete stages (keypoints, RANSAC inliers, reprojection error, OCR crop quality).
4. **Maintainability**: WFG3 encourages engine sprawl and coupling; WFG4 can be modularized around standard interfaces.
5. **Problem-fit**: product asks for geometric transfer of user intent (bbox), not open-ended document cognition.

## Is WFG3 useless?

For *this immediate use case*, large portions of WFG3 are overcomplicated and misaligned.

Useful remnants:
- Existing normalization utilities.
- Any robust bbox-local post-processing/ranking logic.
- Confidence scoring UX patterns.

Non-essential right now:
- Heavy graph/partition/group reasoning before localization.
- Broad structural matching as the primary path.

So WFG3 is not “garbage” globally, but it is close to a dead-end as the mainline engine for the current product objective.

## Engineering/Business Decision Matrix

### Continue investing in WFG3 as primary
- **Time-to-value**: poor.
- **Engineering risk**: high.
- **Browser feasibility**: possible but expensive in CPU/latency tuning.
- **Maintainability**: poor-medium (custom complexity).
- **Chance of solving user problem soon**: medium-low.

### Heavily retrofit WFG3 around OpenCV registration
- **Time-to-value**: medium.
- **Engineering risk**: medium-high (architecture surgery + legacy coupling).
- **Browser feasibility**: good if OpenCV path is dominant.
- **Maintainability**: medium at best unless major cleanup happens.
- **Chance of solving user problem soon**: medium.

### Build WFG4 as separate engine now (recommended)
- **Time-to-value**: best.
- **Engineering risk**: medium-low.
- **Browser feasibility**: high (OpenCV.js + targeted OCR crops).
- **Maintainability**: high if modularized by stage.
- **Chance of solving user problem soon**: high.

## About “uniqueness” of WFG3

Non-traditional ideology is not business value by itself.

It is only valuable if it yields superior reliability, speed, or cost on target workloads. For the current narrow objective, that superiority is unproven and unlikely versus straightforward registration/projection methods.

So yes, WFG3 may be intellectually interesting. That does not justify making it the delivery path.

## What to do now

1. Make WFG4 the primary production path immediately.
2. Treat WFG3 components as optional utilities, not the backbone.
3. Define hard success metrics (bbox IoU after projection, OCR exact-match/F1 on extracted fields, latency p50/p95, fail-open behavior).
4. Keep one narrow fallback from WFG3 only where it empirically beats WFG4 on a measured subset.
5. Sunset unused WFG3 stages quickly to reduce maintenance drag.

## Final Decision

If I were you, I would **stop investing in WFG3 as the core engine and build WFG4 as a separate, OpenCV-centric engine immediately**, reusing only the few WFG3 components that directly improve post-localization extraction quality.
