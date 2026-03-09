# WrokitVision Visual-First Correction Plan

## Purpose
Define a **phased, low-risk** path from the current mixed panel/bbox-heavy behavior toward the intended visual-first architecture.

References:
- `docs/wrokitvision-design-alignment-audit.md`
- `docs/precomputed-structural-mapping-spec.md`
- `docs/wrokitvision-layout-aware-architecture.md`

---

## Phase 0 (Current Pass): Alignment Corrections Without Rewrite

### Goals
1. Make seed precompute image-aware by default where image pixels are available.
2. Keep bbox debug compatibility while adding geometry-faithful region diagnostics.
3. De-emphasize panel as primary displayed truth.

### Changes in this phase
- Ensure `imageData` is passed in seed artifact creation and map-building paths.
- Add a region geometry debug layer that reports contour/hull/rotated-rect when present.
- Keep existing bbox region overlays unchanged for compatibility.
- Shift surface typing away from primary `panel`; keep panel-likeness as derived feature metadata.

### Out of scope
- Region detector redesign.
- Matching/signature rebuild.
- Breaking schema changes.

### Validation
- Unit/integration tests for precompute + debug artifacts.
- Confirm dual-layer debug output (bbox + geometry) is present.
- Confirm surface candidates no longer use `panel` as the primary type.

---

## Phase 1: Visual Evidence Weighting and Scoring Calibration

### Goals
- Increase weight of visual coherence and local frame consistency in ranking.
- Reduce dependence on bbox-derived heuristics as tie-break leaders.

### Expected work
- Tune local relevance/structure weighting.
- Add explainability fields for visual-vs-text contribution.
- Add regression set covering sparse-text/strong-layout documents.

---

## Phase 2: Region Proposal Maturation (Still Compatible)

### Goals
- Improve non-rectangular region fidelity while preserving current APIs.

### Expected work
- Better contour extraction/approximation.
- Rotated region handling beyond axis-aligned fallbacks.
- Cleaner provenance reporting for detector source and confidence composition.

---

## Phase 3: Ontology Cleanup (Careful Compatibility Migration)

### Goals
- Fully establish region/surface-first ontology in typed/debug paths.
- Keep panel/row/column as derived interpretations.

### Expected work
- Compatibility adapter migration strategy.
- UI/debug copy cleanup to avoid panel-first language.
- Schema versioning + migration utilities for downstream consumers.
