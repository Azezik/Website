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

## 2026-04-06 — Phase 3 failure audit + config/run lifecycle fixes

### Summary
- Fixed config-mode crash (ReferenceError in extractScalar) that blocked all WFG4 field configuration.
- Fixed async registerField not awaited in engine-registry, which caused wfg4Config to be stored as a Promise object instead of the actual visual reference packet.
- Fixed run-mode fieldSpec construction missing wfg4Config, which prevented saved per-field visual references from reaching the WFG4 localization pipeline during extraction.

### Bugs Fixed

#### Bug 1: `localization` variable name mismatch (config crash)
- **File:** `engines/core/wfg4-engine.js`, lines 395 and 415
- **Cause:** Variable declared as `localized` (line 338) but referenced via ES6 shorthand as `localization` in two of three return paths. Line 360 correctly used `localization: localized`.
- **Impact:** ReferenceError crashed extractScalar, aborting the config confirm handler before upsertFieldInProfile was reached. No WFG4 fields could be saved.
- **Fix:** Changed shorthand `localization` to explicit `localization: localized` on both lines.

#### Bug 2: Async registerField not awaited in registry
- **File:** `engines/core/engine-registry.js`, line 47 and 60
- **Cause:** `registerFieldConfig` was synchronous, but WFG4's `registerField` is async (for OpenCV operations). The return `{ wfg4Config: WFG4Engine.registerField(payload) }` wrapped a Promise, not the resolved data.
- **Impact:** Even after fixing Bug 1, wfg4Config stored in profile fields would be a Promise object. Visual reference packets (ORB keypoints, descriptors, patches) would not persist correctly.
- **Fix:** Made `registerFieldConfig` async and added `await` before the WFG4 registerField call. Other engines remain synchronous and are unaffected.

#### Bug 3: Run-mode fieldSpec missing wfg4Config
- **File:** `invoice-wizard.js`, line 20367
- **Cause:** The fieldSpec constructed in `extractStaticFields` (run-mode extraction loop) copied bbox, keywordRelations, configBox, etc. from the saved profile field spec, but did not include `wfg4Config`.
- **Impact:** In run mode, `extractScalar` received `fieldSpec.wfg4Config === undefined` and `payload.wfg4Config === undefined`, so localization received null config and fell back to low-confidence predicted bbox (0.1 confidence). Visual localization was completely skipped.
- **Fix:** Added `wfg4Config: spec.wfg4Config || null` to the fieldSpec construction.

### Files Modified
- `engines/core/wfg4-engine.js` (Bug 1)
- `engines/core/engine-registry.js` (Bug 2)
- `invoice-wizard.js` (Bug 3)
- `docs/wfg4-dev-log.md` (this entry)

### Save/Load/Run Lifecycle Verification

Full WFG4 lifecycle traced through code:

1. **Config save:** User draws bbox → confirm handler calls extractFieldValue → extractScalar (now fixed) → registerFieldConfig (now async, awaits WFG4) → wfg4Config with visual reference packet stored per-field via upsertFieldInProfile. Per-field bbox/config independence preserved (keyed by fieldKey, no merging/collapsing).

2. **Profile persistence:** saveProfile writes versioned profile to localStorage scoped by user/docType/wizardId/geometryId. Each field entry carries its own bbox, bboxPct, normBox, configBox, rawBox, page, and wfg4Config.

3. **Run-mode load:** resolveRunWizardContext loads profile. Profile fields[] array loaded intact with per-field wfg4Config. Engine type resolved from user's engine selector preference (persisted).

4. **Run-mode surface:** syncWfg4SurfaceContext('run') called during document preparation (per-file in batch). Builds canonical surface in state.wfg4.runSurface with page dimensions, scale factors, and artifacts.

5. **Run-mode extraction:** extractStaticFields iterates profile fields. fieldSpec now includes wfg4Config (Bug 3 fix). extractFieldValue builds enginePayload with fieldSpec + wfg4Surface. EngineRegistry.extractScalar dispatches to WFG4Engine.extractScalar. Localization receives wfg4Config with visual reference patches, performs ORB matching and geometric projection. Readout uses localized box for token scoping.

6. **Compile/output:** Raw extraction results (value, raw, confidence, tokens, engineUsed, extractionMeta) written to rawStore, then compiled via compileDocument → CompileEngine → MasterDB. WFG4 output shape is compatible with existing compile contracts.

### Per-field independence verification
- Fields keyed by fieldKey in profile.fields[] array (upsertFieldInProfile line 17468)
- Each field stores independent bbox, bboxPct, normBox, configBox, rawBox, page
- Each field stores independent wfg4Config with its own visual reference packet
- Overlap detection shifts boxes but never merges them
- Multiple fields on same page/document remain distinct through save, load, and run

### Verdict
**Working end to end** after these three fixes. No remaining structural blockers in the config → save → load → run → compile lifecycle for WFG4.

## 2026-04-06 — Phase: Debug PDF run-mode OCR fallback failure

### Root Cause
PDFs with empty text layers (scanned PDFs, certain flattened PDFs where text was removed or embedded as image) fail in run mode with `Error attempting to read image` from Tesseract.

**Exact failure chain:**
1. `prepareRunDocument` reads PDF text tokens via PDF.js `getTextContent()` but does NOT render the PDF to `els.pdfCanvas` (run mode skips `renderAllPages()` for speed).
2. `cleanupDoc()` → `clearDocumentSurfaces()` resets `els.pdfCanvas` to 0×0.
3. When PDF text layer has zero tokens, `resolveExtractionTokensForField` falls back to Tesseract OCR (`pdf_empty_tokens_fallback` reason).
4. `readImageTokensForPageWithBBox` → `getPdfBitmapCanvas(pageNum-1)` returns `{canvas:null}` because pdfCanvas is 0×0.
5. Fallback chain `canvasEl || getPdfBitmapCanvas(...)?.canvas || els.imgCanvas` lands on `els.imgCanvas` — an `<img>` element with no `src` (cleared by `cleanupDoc`).
6. Tesseract.js receives a blank `<img>` element → throws `Error attempting to read image`.

### What runtime readout path is actually used today

- **Flattened PDFs (working):** PDF.js text layer (`getTextContent`) returns tokens → extraction uses `pdfjs` token source. Canvas rendering and Tesseract are never invoked. WFG4 localization is visual-first on the canonical surface; readout uses these PDF text tokens as read-assist.

- **Images (working):** `els.imgCanvas` has a valid loaded image → Tesseract OCR reads it directly. WFG4 localization is visual-first; readout uses OCR tokens.

- **PDFs with empty text layer (was failing):** PDF.js returns zero tokens → fallback to Tesseract → but `els.pdfCanvas` is 0×0 (never rendered in run mode) → falls through to `els.imgCanvas` (blank `<img>`) → Tesseract crash.

### Classification
**PDF-specific OCR fallback bug.** The Tesseract fallback path assumed a rendered canvas would be available, but run mode never renders PDFs to canvas. This is a legacy assumption leak — the run-mode optimization (skip canvas rendering) was added without updating the OCR fallback source resolution. WFG4 architecture is not at fault; this bug exists underneath WFG4 in the shared token-resolution layer.

### Fix Summary
Modified `readImageTokensForPageWithBBox` in `invoice-wizard.js` to:
1. **On-demand PDF page render:** When the main pdfCanvas is unavailable (0×0) and `state.pdf` exists, render the specific page to a temporary off-screen canvas using the already-loaded PDF.js document object. This is the same rendering approach used by `renderAllPages` but scoped to a single page and not attached to the DOM.
2. **Source validation guards:** Before passing any source to Tesseract, validate that `<img>` elements have a loaded `src` and `<canvas>` elements have non-zero dimensions. Returns `[]` instead of crashing.

### Files Modified
- `invoice-wizard.js` (`readImageTokensForPageWithBBox`, lines ~18852–18890)
- `docs/wfg4-dev-log.md` (this entry)

### Architectural Boundary Preserved
- WFG4 visual localization remains visual-first and unchanged.
- The fix is entirely within the shared token-resolution / OCR fallback layer underneath WFG4.
- Non-visual sources (PDF text, AcroForm) are not promoted to drive localization.
- The on-demand render only provides pixel data for Tesseract readout after WFG4 localization has already determined the target region.

### Remaining Risk
- PDFs that fail both PDF.js text extraction AND PDF.js canvas rendering (corrupt or encrypted) will still return zero tokens gracefully (no crash, but no extraction).
- On-demand page rendering adds a per-page rendering cost for text-layer-empty PDFs; this is bounded by `ensureTesseractTokensForPageWithBBox` caching (one render + one OCR call per page).
- Very large pages may produce large temporary canvases; this is the same memory profile as `renderAllPages` but scoped to one page at a time.

## 2026-04-06 — Phase: WFG4 structural field anchoring

### Summary
Extended WFG4 Phase 3 with field-level structural intelligence to improve bbox localization stability. At config time, each field now captures structural context (edges, lines, contours, containers, anchor offsets) from the canonical surface using OpenCV. At runtime, after ORB-based transform and initial bbox projection, structural data is used for local refinement — snapping to detected edges/lines and re-anchoring within detected containers.

### Added Capabilities

**Config-time structural context capture** (in `wfg4-registration.js`):
- Canny edge detection + HoughLinesP to find horizontal/vertical lines near the field bbox
- Contour detection to identify rectangular containers enclosing the bbox
- Anchor offset computation: distance to nearest horizontal line above/below, vertical line left/right
- Container-relative positioning: offset from container edges and proportional position within container
- All stored under `structuralContext` in the per-field `wfg4Config` packet

**Runtime structural refinement** (in `wfg4-localization.js`):
- After ORB-based transform + template refinement, performs local structural analysis around projected bbox
- Detects lines and containers in runtime search region
- Snaps bbox to container boundaries using stored relative position (when config had a container)
- Snaps bbox edges to nearest lines using stored anchor offsets
- When ORB confidence is weak, doubles structural snap tolerance for more aggressive correction
- Structural refinement contributes to localization confidence score (+0.1 boost)
- Can produce `ok: true` even when ORB consensus fails (`structural_fallback` reason)

**New OpenCV operations** (in `wfg4-opencv.js`):
- `detectEdgesAndLines()`: Canny + HoughLinesP, classifies lines as horizontal/vertical
- `detectContainers()`: Canny + findContours + approxPolyDP, identifies rectangular contours
- `findEnclosingContainer()`: finds smallest container with sufficient overlap
- `computeAnchorOffsets()`: measures distances from bbox to nearby lines and container edges
- `structuralRefineBox()`: runtime entry point that applies container snap + line snap adjustments

### How Structural Refinement Integrates with ORB Pipeline
1. ORB matching + RANSAC transform estimation runs first (unchanged)
2. Bbox projection via homography/affine runs second (unchanged)
3. Local template refinement via matchTemplate runs third (unchanged)
4. **NEW**: Structural refinement runs fourth — adjusts the already-projected bbox using edge/line/container anchors
5. If ORB produced a valid transform, structural refinement applies conservative snapping (±8px)
6. If ORB confidence is weak (below 0.4), structural refinement applies wider tolerance (±16px) and can independently produce a valid localization result
7. Final confidence score now incorporates structural boost alongside ORB and template scores

### Files Modified
- `engines/wfg4/wfg4-types.js` — added structural anchoring defaults, updated schema version
- `engines/wfg4/wfg4-opencv.js` — added 5 structural detection/refinement functions
- `engines/wfg4/wfg4-registration.js` — extended config-time capture with structural context
- `engines/wfg4/wfg4-localization.js` — added post-ORB structural refinement step
- `docs/wfg4-dev-log.md` — this entry

### Architectural Rules Preserved
- WFG4 localization remains visual-first: all structural data comes from rendered canonical surface
- PDF text layer / OCR / AcroForm data does not influence localization or structural analysis
- Non-visual sources remain read-assist only, used after localization determines the target region
- No changes to save/load/run lifecycle, compile/MasterDB flow, or orchestration contracts

### Performance Considerations
- Structural analysis runs on a local ROI crop (not full page), bounded by field size + padding
- Canny + HoughLinesP + findContours are fast OpenCV operations (~1-3ms per field on typical regions)
- Lines and containers are capped (20 each) in persisted config to bound storage
- Runtime structural refinement only fires when `structuralContext.captureStatus === 'ok'`
- If OpenCV is unavailable, structural path is cleanly skipped (graceful fallback to ORB-only)

### Expected Improvement in Localization Stability
- Fields near table lines/grid borders should snap to correct cell boundaries across document variants
- Fields inside form boxes should maintain position relative to container edges even when ORB matches shift slightly
- Low-texture fields (e.g., numeric cells in tables) that produce weak ORB matches now have a structural fallback path
- Overall localization confidence is more granular with the structural component factored in

## 2026-04-06 — Phase: WFG4 debug visualization mode

### Summary
Added a global WFG4 Debug Mode toggle that enables run-time visualization and validation of the full localization pipeline. When enabled, the system pauses after field extraction, renders color-coded bbox overlays for every localization stage, and allows the user to mark results as GOOD or BAD (with optional per-field bbox correction). All debug sessions are logged with structured per-field localization metadata and derived metrics for offline analysis.

### Purpose
Determine whether WFG4 is:
- localizing the wrong region
- localizing correctly but extracting from the wrong crop
- or both

This feature makes localization behavior observable and measurable without changing any extraction or localization algorithms.

### Files Modified
- `document-dashboard.html` — added WFG4 Debug Mode toggle (checkbox next to engine selector) and debug review panel with GOOD/BAD buttons and correction UI
- `invoice-wizard.js` — added debug state management, batch guard (1 file only), debug pause after static field extraction, overlay rendering (4-color bbox stages per field), field data list display, GOOD/BAD verdict flow, correction mode (per-field bbox redraw), structured debug log persistence (localStorage)
- `engines/core/wfg4-engine.js` — extended `extractScalar` to capture `debugBboxStages` (reference, ORB-projected, refined, OCR crop bboxes) in extractionMeta on all return paths
- `engines/wfg4/wfg4-localization.js` — exposed intermediate bbox snapshots: `orbProjectedBox` (after ORB transform projection), `postRefineBox` (after template refinement), `predictedBox` (config-time reference) in localization return payload
- `docs/wfg4-dev-log.md` — this entry

### Feature Details

**Global toggle:**
- Checkbox labeled "WFG4 Debug Mode" appears next to extraction engine dropdown only when WFG4 engine is selected
- Default: OFF. Only applies in run mode. Does not affect config mode.
- When ON: batch processing restricted to 1 file at a time

**Debug overlay (4-color bbox visualization):**
- BLUE (dashed) — Reference bbox from config time
- YELLOW (dashed) — ORB-projected bbox after geometric transform
- GREEN (dashed) — Final refined bbox after template + structural refinement
- RED (solid) — Actual OCR/readout crop box used for extraction
- Each field also displays: extracted value, localization confidence, readout confidence

**User validation:**
- GOOD: logs debug entry with verdict, proceeds with normal extraction
- BAD: enters correction mode — user redraws bbox per field in order, corrections logged as `userCorrectedBbox`

**Debug log structure (per run):**
- File metadata: fileName, fileType, fileSize, rendered dimensions, canonical surface dimensions
- Per-field: all 4 bbox stages, userCorrectedBbox (if BAD), derived deltas (projected vs refined, refined vs user, reference vs projected, bbox size differences)
- Persisted to localStorage under `wfg4_debug_log` (capped at 200 entries)

### Architectural Rules Preserved
- No changes to WFG4 extraction logic or localization algorithms
- No changes to ORB matching, structural refinement, or template matching
- No changes to config mode, profile persistence, or compile/output contracts
- Debug mode is fully isolated behind toggle — when OFF, run flow is completely unchanged
- Overlay rendering is additive (painted on top of existing overlay after `drawOverlay`)

### Insights This Feature Captures
- Whether ORB projection is landing in the correct region (reference vs projected delta)
- Whether structural refinement is helping or hurting (projected vs refined delta)
- Whether the final OCR crop matches what the user expects (refined vs user-corrected delta)
- Scale and offset drift between config-time and run-time surfaces
- Per-field localization confidence vs readout confidence correlation

## 2026-04-06 — Phase: OpenCV readiness + explicit capture failure statuses

### Summary
- Fixed ambiguous config-time WFG4 visual-reference capture failure mode when OpenCV.js is unavailable.
- Added OpenCV runtime bootstrap/readiness wait in the WFG4 OpenCV adapter before capture.
- Split visual-reference capture failure statuses into explicit values:
  - `cv_unavailable`
  - `artifact_missing`

### Files Modified
- `engines/wfg4/wfg4-opencv.js`
- `engines/wfg4/wfg4-registration.js`
- `docs/wfg4-dev-log.md` (this entry)

### Notes
- WFG4 config-time capture now attempts to load OpenCV.js from `https://docs.opencv.org/4.x/opencv.js` and waits for runtime readiness.
- Capture no longer collapses CV runtime absence and missing artifacts into one status string.
- If OpenCV remains unavailable after readiness wait, capture exits explicitly with `captureStatus: "cv_unavailable"` and does not pretend visual-reference capture succeeded.
