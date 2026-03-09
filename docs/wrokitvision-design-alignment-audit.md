# WrokitVision Design-Alignment Audit (Visual-First)

## Scope
This audit is the current **source of truth** for design alignment corrections.
It is anchored to the architecture intent in:

- `docs/precomputed-structural-mapping-spec.md`
- `docs/wrokitvision-layout-aware-architecture.md`
- `docs/skinv2-canonical-architecture-map.md`

## Intended Architecture (reference)
WrokitVision is intended to be **visual-first**:

1. Upload-time precompute proposes broad visual/text structural candidates.
2. User selection resolves a local subgraph from those candidates.
3. Field semantics are interpreted from local structure/signature evidence.

In this model, panels/rows/columns are interpretations, not primitive truth objects.

## Confirmed Misalignment Findings
Treat these findings as true:

1. **Panel is too primitive in effective practice.**
2. **Region generation remains rectangle-centric.**
3. **Visual signals are underweighted in the effective path.**
4. **Seed precompute is biased when created without imageData.**
5. **Debug overlay is bbox-heavy and can read as ontology, not convenience.**

## Phase 0 Correction Objective
Implement the smallest safe corrections that:

- make `imageData` first-class when seed/precompute artifacts are created,
- preserve current bbox overlays for compatibility,
- add a richer geometry-faithful debug layer,
- de-emphasize panel as primary displayed truth,
- avoid broad rewrites of region generation or matching/signature architecture.

## Non-Goals for this Pass
- No broad architecture rewrite.
- No replacement of matching/signature systems.
- No compatibility-layer removals unless clearly safe.
- No full region-generation redesign.

## Exit Criteria for this Pass
- Seed/precompute calls pass `imageData` wherever available.
- Debug artifacts expose both:
  - bbox compatibility layer, and
  - geometry-faithful region layer (contour/hull/rotated-rect when present; bbox fallback).
- Panel remains available only as derived/debug interpretation, not primary region ontology.
