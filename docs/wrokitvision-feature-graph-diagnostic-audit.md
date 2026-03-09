# WrokitVision Design-Alignment Audit (Panel Bias vs Visual-First Intent)

## Context
This audit compares the **current live wizard implementation** against the original WrokitVision design intent (visual-first, broad structural precompute, user-anchored local resolution).

This is a diagnostic pass only: no runtime behavior changes are proposed in this document.

---

## Part 1 — Concise Design-Alignment Diagnosis

### Verdict
The current implementation is **mixed**, but **closer to panel-first / bbox-first than the intended visual-first architecture**.

### Why
- The rendered Feature Graph is overwhelmingly rectangle/bbox based (structural nodes are drawn as rectangles, and the visual region layer is also rendered as rectangular bounds).
- The legacy structural path explicitly constructs grid cells/corridors and labels them as `panel_*` nodes.
- Typed precompute includes some visual components, but in the effective live path, seed artifacts are often built from tokens + viewport without image pixels, so text/layout primitives dominate.

### What is aligned
- The two-phase concept does exist: upload-time precompute plus post-selection local association/resolution/signature stack.
- Typed graph objects and staged pipeline modules (selection association, local relevance, local subgraph, local structure, local frame, field signature) are present and wired.

---

## Part 2 — Specific Drift Report

## A) Where panel assumptions still exist

1. **Legacy structural graph is explicitly panelized**
   - Pixel path: detect lines + whitespace corridors → build grid cells → merge cells → emit `panel_*` nodes of type `panel`.
   - This is a direct panel-construction pipeline, not an emergent region-shape pipeline.

2. **Surface candidate heuristic directly classifies "panel" from bbox stats**
   - `isPanel = isLarge && textDensity < 0.35` then `surfaceType = 'panel'`.
   - This treats panel as a primitive class inferred from coarse area+density thresholds.

3. **Typed-to-legacy compat keeps region geometry as rectangle-centric**
   - Region nodes are adapted to legacy rectangular node format and visual layer is synthesized from those nodes.

## B) Where bbox assumptions still exist

1. **Overlay draws regions by `fillRect/strokeRect` for both structural and visual layers**
   - Feature Graph and visual regions are represented/displayed as axis-aligned rectangles.

2. **Typed visual proposals collapse connected components to bounding boxes**
   - Connected components are found on threshold masks, but emitted geometry is bbox only.

3. **Compat visual layer assigns visual descriptors from node boxes**
   - `meanLuminance` defaults to `0.5` when unavailable and `fillRatio` is fixed to `1`, reinforcing box-level abstraction over true contour fidelity.

## C) Where OCR/layout assumptions dominate too early

1. **Typed region proposals always include text envelopes and text hull**
   - Per-line expanded rectangles (`text_strip`) and full text hull (`text_cluster`) are guaranteed outputs.

2. **Page-frame region always injected**
   - A full-page `page_surface` region is always added when viewport is known.

3. **Seed precompute call omits `imageData` in config-time seed creation**
   - `createSeedArtifacts({ tokens, viewport })` is called without image pixels, making early artifact structure text/layout-heavy.

---

## Part 3 — Corrective Direction (Architectural, no rewrite)

## A) What should change (minimum realistic direction)

1. **Demote panel as primitive; promote generic region/surface primitives first**
   - Keep panel as a *derived label* (late-stage interpretation), not a generation target.
   - Region proposal stage should prioritize generic coherent regions (surfaces/contours/components), then classify some as panel-like if warranted.

2. **Preserve richer geometry in typed artifacts**
   - Add/retain contour/hull/rotated-rect descriptors as first-class fields in region nodes.
   - Keep bbox as convenience, not canonical geometry.

3. **Make visual path first-class in seed precompute for wizard debug path**
   - Ensure seed precompute receives `imageData` where available so the artifact is not text/layout-skewed by default.

4. **Treat overlay panel rectangles as one debug layer, not the truth layer**
   - Continue rendering bboxes for inspectability, but add a geometry-faithful layer (hulls/rotated boxes/contour approximations) as primary for feature-region diagnostics.

5. **Shift scoring toward local resolved subgraph quality rather than panel presence**
   - Keep existing local relevance/structure/frame/signature modules, but weight evidence from visual coherence + local frame consistency + selection-centered structure before panel heuristics.

## B) What can stay

- Two-phase architecture (upload precompute + post-selection local resolution).
- Typed artifacts and compat wiring (short-term compatibility is useful).
- Text topology pipeline and current text graph UX (already believable and useful).
- Selection association, local relevance, local structure, local frame, field signature modules.

## C) What should be de-emphasized

- Hard-coded panel detection as a primary structural outcome.
- Grid/corridor panelization as the dominant representation for non-document photos.
- Interpreting rectangular partitions as equivalent to region understanding.

## D) What should become emergent rather than primitive

- Panels, rows, columns, and cells should emerge from general region/surface graph + text topology + local relevance resolution, not be assumed in early region generation.

---

## Part 4 — Documentation Update Plan

## Recommendation
Adopt a **three-document correction package** (small, focused, and actionable):

1. **New doc (recommended):** `docs/wrokitvision-design-alignment-audit.md`
   - Single-source diagnosis of intended vs actual architecture.
   - Include a concise "panel-first drift" section and current-state diagram.

2. **Update existing architecture doc(s):**
   - Add an explicit rule: "panel is a derived interpretation, not a primitive region type." 
   - Add canonical geometry hierarchy: contour/hull/rotated-rect/bbox (bbox last).

3. **Add migration/correction note:** `docs/wrokitvision-visual-first-correction-plan.md`
   - Phase 0 (compat-safe): seed precompute receives imageData; overlay adds geometry-faithful debug layer.
   - Phase 1: typed region nodes gain contour/hull fields + confidence provenance.
   - Phase 2: reduce legacy panel-path weight in matching/relevance for non-document visuals.

This preserves current investment while steering implementation back to original visual-first intent.

---

## Evidence anchors (current implementation)

### Upload/data flow and map build path
- Upload flow branches image vs PDF; both resolve OCR token streams and viewport before overlay graph use.
- Debug map builder prefers pdf.js tokens, falls back to tesseract bbox tokens, optionally extracts grayscale image data, and calls WrokitVision `buildMaps(...)`.
- `buildMaps` routes to typed-precompute compat when `precomputedStructuralMap` is available.

### Panelized / rectangle-heavy behavior
- Legacy structural map builds regions from structural lines + whitespace corridors (grid cells), merges cells, emits `panel_*` nodes.
- Feature graph overlay draws structural nodes and visual regions as rectangles.
- Surface candidate heuristic emits `panel` by area/text-density threshold.

### Typed path simplification and defaults
- Region proposals include text envelopes, text hull, optional visual connected components, and page frame.
- Visual connected components are represented by bbox.
- Compat visual layer sets fallback luminance and fixed fill ratio when adapting to legacy maps.

### Seed precompute bias
- Current seed creation path in wizard calls `createSeedArtifacts({ tokens, viewport })` without `imageData`, which can bias precompute toward text/layout structure.
