## 2026-04-05 — Phase 2A / 2B (Canonical Surface + Config Display Substitution)

### Summary
- Implemented real WFG4 canonical surface generation in `WFG4Engine.prepareDocumentSurface(...)` using OpenCV.js operations (resize, grayscale, Gaussian denoise, Canny edges) with browser-safe fallback behavior.
- Implemented config-mode display-surface substitution for WFG4 so the user draws directly on the WFG4 canonical surface (no dual visible surface in config mode).
- Updated config capture behavior for WFG4 to keep user bbox geometry in the canonical WFG4 surface space.

### Files Modified
- `engines/core/wfg4-engine.js`
- `invoice-wizard.js`
- `docs/wfg4-dev-log.md`

### Key Architectural Decisions
- Reused the existing `#pdfCanvas` viewer base node as the canonical-surface display target in config mode to avoid UI shell redesign.
- Used existing `syncWfg4SurfaceContext('config'|'run')` seam to build canonical surface and trigger config-time display swap only for WFG4.
- Isolated display substitution via helper routing (`getActiveDisplaySurfaceNode`) so overlay sizing/pinning uses canonical surface only when WFG4 config display is active.
- Disabled raw-token snapping behavior for WFG4 config selections; selection boxes are captured directly from the canonical display geometry.

### Assumptions
- OpenCV.js may not always be present at runtime; canonical-surface generation remains functional with graceful canvas fallback diagnostics.
- Existing token streams remain raw-render-derived; WFG4 scalar extraction now scales token boxes to canonical page space when needed.

### Risks / Uncertainties
- Some diagnostic/learning helper paths that rely on active display node now follow the canonical display while WFG4 config mode is active; this is intended for coordinate consistency but should be validated in advanced debug workflows.
- Canvas data URL artifacts increase in-memory surface payload size for large multi-page documents.

## 2026-04-05 — Phase: WFG4 debug watermark

### Files Modified
- `invoice-wizard.js`
- `docs/wfg4-dev-log.md`

### What Was Added
- Added a config-only WFG4 debug watermark overlay element that is attached to the same viewer container as document and bbox overlay layers.
- Watermark visibility is gated to only show when:
  - configured engine is `wfg4`,
  - config mode is active,
  - canonical WFG4 config display is currently active.
- Watermark text is dynamically generated as:
  - `WFG4 Surface (page X, WIDTH x HEIGHT)`
  - where `X` uses the current 1-based page number and `WIDTH/HEIGHT` come from WFG4 canonical page working dimensions metadata.
- Watermark is non-interactive (`pointer-events: none`) and layered above overlays without affecting selection math or engine internals.

### Assumptions
- Canonical dimensions are read from `state.wfg4.configSurface.pages[pageIndex].dimensions.working` with fallback to original/page dimensions if needed.
- Page number shown is the active viewer page (`state.pageNum`), which is already managed as 1-based in wizard UI.

## 2026-04-05 — Phase: WFG4 extraction audit (PDF vs Image)

### Summary
- Runtime orchestration is shared across document types (`EngineExtraction` + `EngineRegistry`), but token acquisition still branches by source type (`state.isImage`): PDFs use PDF text (+ AcroForm overlay), images use Tesseract OCR.
- PDF tokens come from `pdf.js getTextContent()` in page viewport coordinates (plus optional AcroForm widget-derived tokens), which are typically cleaner than OCR output.
- Image tokens come from full-page Tesseract word boxes and are scaled from natural-image coordinates into displayed canvas coordinates before extraction.
- WFG4 config capture stores bbox coordinates from the active canonical display geometry; in config mode this is the WFG4 substituted canonical surface.
- In WFG4 extraction, tokens are remapped into canonical working scale using `workingFromOriginal` factors, while the extraction box is passed through as-is from runtime viewport-derived px coordinates.

### Key difference (PDF vs image extraction path)
- PDF path is text-layer-first (`pdfjs`/`acroform`) with optional Tesseract fallback when PDF extraction returns empty; image path is OCR-only from the start (no structural text layer to fall back to).

### Risks / inconsistencies identified
- Mixed token provenance persists (text-layer vs OCR), so extraction quality and confidence are source-dependent rather than normalized.
- Coordinate handling is hybrid in WFG4 runtime (canonical token remap + viewport-derived box), which is internally sensitive to scaling assumptions.
- Image ingest downscales display to a capped width before OCR token usage, reducing spatial/text detail compared to PDF text-layer extraction.

## 2026-04-06 — Phase: WFG4 architectural rule — visual localization, assisted readout

### Decision (hard boundary for future phases)
- For WFG4, the canonical visible WFG4 surface is the primary truth for registration, anchoring, triangulation, bbox projection, field localization, and orientation/structural matching.
- Non-visual or non-rendered sources (PDF text layer, AcroForm/form data, hidden text, or other invisible token sources) must not be used as primary truth for localization or geometry decisions.
- These sources are allowed only as localized read-assist after WFG4 has already localized the target field region through the visual pipeline.

### Operational rule
- Find the area visually first.
- Then optionally read within that localized area using OCR, PDF text, or form data.
- Hidden/non-visual text must never drive where WFG4 localizes a field.

## 2026-04-06 — Phase 3A / 3B / 3C (Visual reference packet + OpenCV localization + localized readout)

### Summary
- Added Phase 3 config-time visual reference packet capture for WFG4 static fields, storing canonical bbox metadata plus local patch and expanded neighborhood patch artifacts with ORB keypoints/descriptors.
- Added browser-only OpenCV.js runtime localization for WFG4: ORB feature extraction, BFMatcher ratio-test matching, RANSAC-based transform estimation (homography-first with affine fallback), bbox projection, and local template refinement.
- Updated WFG4 extraction flow so readout happens only after visual localization; token/PDF/AcroForm/OCR sources are now read-assist for the already-localized region.
- Added explicit localization diagnostics/confidence in `extractionMeta.localization`, separate from readout confidence.

### Files Modified
- `document-dashboard.html`
- `invoice-wizard.js`
- `engines/core/wfg4-engine.js`
- `docs/wfg4-dev-log.md`

### Files Added
- `engines/wfg4/wfg4-types.js`
- `engines/wfg4/wfg4-opencv.js`
- `engines/wfg4/wfg4-registration.js`
- `engines/wfg4/wfg4-localization.js`

### Key Architectural Decisions
- Kept Phase 3 storage bounded to local scope (field patch + expanded neighborhood) and did not persist page-level descriptors to avoid profile/storage bloat in v1.
- Implemented a hybrid localization strategy that is still bbox-first: neighborhood-to-search-window registration around predicted canonical location, then local refinement.
- Established transform gating thresholds for projection: homography requires >=10 good matches and >=8 inliers; affine fallback requires >=6 good matches and >=5 inliers; both require inlier ratio >=0.35.
- Preserved existing run orchestration and profile contracts by extending only engine-owned `wfg4Config` and the existing `extractScalar` payload/result path.

### Assumptions
- OpenCV.js runtime includes ORB/BFMatcher/findHomography/estimateAffinePartial2D APIs in the target browser bundle.
- Runtime canonical surface artifacts (`displayDataUrl`) remain available for reference/runtime patch decoding.

### Risks / Uncertainties
- Descriptor serialization can still add profile size for many fields; bounded local packets reduce but do not eliminate payload growth.
- On low-texture regions, geometric consensus may be weak; localization falls back to predicted bbox with low localization confidence.
- Template refinement currently assumes limited scale drift around the projected box; larger scale variance may require multi-scale refinement in a later phase.
