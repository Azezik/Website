# WFG4 Visual Intake Architecture Replacement (WFG3-style)

Date: 2026-04-10

## Scope
This change replaces WFG4 downstream authority from mixed PDF/display viewport geometry to a **single visual-surface authority**.

## Modified files and codepaths

### 1) `invoice-wizard.js`

#### Replaced viewport authority helpers
- **Function modified:** `getWfg4CanonicalViewport(pageNum, modeHint)`
- **Previous behavior:** Could reflect legacy canonical/page viewport assumptions derived from prior flow state.
- **New behavior:** Viewport is read from WFG4 surface page dimensions (`working`/`original`) only.
- **Why:** single-space visual authority for WFG4.

- **Function modified:** `projectTokensToWfg4Canonical(tokens, ...)`
- **Previous behavior:** could remap from `state.pageViewports/state.viewport` authority.
- **New behavior:** remaps only against the WFG4 visual-surface viewport (or provided visual hint), never against PDF-view geometry authority.
- **Why:** prevent PDF-space token authority from leaking downstream.

#### Added unified visual intake builder
- **Function added:** `cloneCanvasVisualSurface(inputCanvas, width, height)`
- Clones an intake canvas into a detached visual canvas.

- **Function added:** `buildWfg4VisualIntakePages()`
- **Purpose:** source-agnostic intake convergence.
  - Image: clone `els.imgCanvas` into page 1.
  - PDF: clone per-page cached raster canvases from `state.wfg4.pageCanvases`.
- **Result:** WFG4 receives pages as one shared visual representation regardless of source type.

#### Replaced WFG4 surface capture model
- **Function modified:** `captureWfg4SurfaceForMode(mode)`
- **Previous behavior:** mixed dependence on page viewport arrays and fallback geometry.
- **New behavior:** builds pages exclusively from `buildWfg4VisualIntakePages()` and sets active viewport from that visual page.
- **Result:** after intake, WFG4 works from visual pages only.

#### Token resolver behavior update (visual-first)
- **Function modified:** `resolveExtractionTokensForField(...)`
- **New rule:** visual OCR (`tesseract-bbox`) remains primary.
- PDF text path is retained only as explicit request or fallback and marked non-authoritative in resolver reasons.
- Projection for fallback tokens now uses visual/canonical viewport, not PDF viewport arrays.

### 2) `engines/core/wfg4-capture-frame.js`

#### Removed display viewport dependency in capture frame scaling
- **Removed function:** `pickVp(state, idx)`
- **Function modified:** `buildCaptureFrame(...)`
- **Previous behavior:** display dimensions could be derived from `state.pageViewports/state.viewport`.
- **New behavior:** display dimensions are set to WFG4 working dimensions directly (`display == working` for frame math authority).
- **Result:** one geometry authority within CaptureFrame.

#### Source typing updated to visual intake semantics
- **Function modified:** `buildCaptureFrame(...)` (`sourceType` field)
- **Previous behavior:** included `pdf-text-layer` classification branch.
- **New behavior:** `image-visual-intake` or `pdf-raster-visual-intake`.
- **Result:** removes text-layer-first semantic framing from geometry pipeline.

## Removed/replaced authority patterns
- Replaced WFG4 token projection dependence on legacy viewport arrays as authority.
- Replaced WFG4 capture-page intake dependence on mixed viewport/page arrays with visual-page intake builder.
- Removed CaptureFrame display-scaling dependence on state page viewport arrays.

## Downstream authority model after change
- **Page space:** WFG4 surface page dimensions (visual working surface).
- **BBox space:** WFG4 working visual page coordinates.
- **Token space:** projected into WFG4 visual page coordinates.
- **Localization/extraction readout:** anchored to WFG4 visual surface + capture frame derived from it.

## Notes for debugging
If regressions appear, inspect these first:
1. `buildWfg4VisualIntakePages()` output dimensions per page.
2. `captureWfg4SurfaceForMode()` payload page list and active viewport.
3. `projectTokensToWfg4Canonical()` input viewport hint and output scaling.
4. `WFG4CaptureFrame.build()` display/working scale values.
