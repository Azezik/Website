# WFG4 Capture Frame — Technical Progress & Context Log

**Status:** P0 in progress
**Branch:** `claude/audit-wfg4-pipeline-3I8uW`
**Scope:** Fix scanned-PDF / image config-mode extraction without disturbing the text-layer PDF path.

This document is the source of truth for any future agent or thread picking up this work. Read it before touching anything.

---

## 1. Current System State

### Symptom
- User draws a bbox in config mode on a raster image or scanned PDF.
- Confirm returns text that is **not** what was inside the box.
- First click often "does nothing"; a second click succeeds.
- Works fine on PDFs that have a real text layer.
- Debug overlays do not visually line up with where extraction happened, even when extraction is correct.

### Root cause (two distinct phenomena)

**A. Coordinate Space Divergence (refined after deeper code read).**
The "literal user bbox" exists in **three different pixel spaces**:

1. **Display viewport space** — `state.pageViewports[pageNum-1]`. This is what `state.snappedPx` is recorded in. Tesseract tokens are also produced in this space (Tesseract runs on the live rendered canvas / `tmp` render at `vp.width`, not on `displayDataUrl`).
2. **Working surface space** — `pageEntry.dimensions.working` from `buildWorkingSize()`. Aspect-preserving, longest edge ≤ 1600px. This is the space `pageEntry.artifacts.displayDataUrl` and all OpenCV feature extraction (`wfg4-registration.js` `resolveCanonicalBox` → `cropCanvas(pageCanvas, canonicalBox)`) operate in.
3. **Display canvas CSS rect** — what `getScaleFactors()` (`invoice-wizard.js:15895–15903`) returns; used by overlays.

**Each sub-pipeline is internally consistent.** The Tesseract readout path stays in viewport space throughout (`state.snappedPx` + viewport-space tokens). The OpenCV feature path stays in working space throughout (`normBox` × working dims → `canonicalBox` → crop from working-space `pageCanvas`). The two do not touch.

The real failure mode is therefore **not** "cropCanvas crops the wrong rectangle" — it is:
- **B** below (async readiness race causing `localization_failed` → empty extraction that looks like "wrong text"), and
- **proportion drift** when `state.pageViewports[n-1]` and `pageEntry.dimensions.working` have even slightly different aspect ratios (working is aspect-preserving against the *original* image dims, viewport may reflect a different scale). In that case normalized bbox ratios drift and the OpenCV field patch is offset from what the user drew. This is the secondary, quiet failure mode.

The redesign's `configModeAuthoritative` short-circuit at `wfg4-engine.js:443–455` correctly prevents Phase 4–7 re-localization from clobbering the user box, so the box it carries forward *is* the user's box — but in the wrong space.

**B. Token Rescue on Text-Layer PDFs.**
`wfg4-engine.js:556–567` does `tokensInBox(allTokens, finalBox, 0.2)` — any PDF text-layer token whose area overlaps `finalBox` by ≥20% is accepted. On text-layer PDFs the token cloud is dense and continuous, so even a misplaced `finalBox` overlaps the intended words and returns them. This is why text-layer PDFs appear to work: the token scoping silently rescues the geometry bug. Scanned PDFs and images have no token layer, so `needsLocalizedReadout` triggers, Tesseract runs on the misaligned crop, and the bug becomes visible.

**C. Confirm-time async race.**
`state.wfg4.configSurface` and `ensureCvReady()` can still be in flight when the user clicks Confirm. The prelim `registerFieldConfig` throws, and the `catch` at `invoice-wizard.js:19786` silently swallows it. The main extraction proceeds against a half-prepared surface. On the second click, the surface is ready, and extraction "works." This is the multi-click symptom.

### What is **not** the problem
- The Phase 1–7 structural redesign is fully wired. Verified at: `wfg4-engine.js:298–310`, `wfg4-registration.js:250–290`, `wfg4-localization.js:234–305`, `wfg4-opencv.js:525–1600`.
- The 96343f3 literal-bbox gate is reached on all three source types (image, scanned PDF, text-layer PDF). It is not being bypassed.
- There is no lingering legacy pipeline running in parallel.

---

## 2. Smoking Gun Files

### `engines/core/wfg4-engine.js`

- **Lines 117–133** `buildWorkingSize()` — defines the working surface. This is the **canonical pixel space** we are unifying on. `pageEntry.dimensions.working` and `pageEntry.scale.workingFromOriginalX/Y` are set here.
- **Lines 212–250** `normalizePage` / `normalizeWithOpenCv` — produces `pageEntry.artifacts.displayDataUrl` **in working space**. Every Tesseract crop is taken from this image.
- **Lines 443–455** `configModeAuthoritative` short-circuit — **correct in intent**, but the `boxPx` it receives is in display-viewport space, not working space. This is where the space translation must land.
- **Lines 556–588** token scoping + `needsLocalizedReadout` branch — the point where text-layer PDFs silently rescue the geometry bug; also the point where scanned/image paths hand off to Tesseract on the wrong surface.

### `invoice-wizard.js`

- **Lines ~10102–10140** `extractFieldValue` — constructs the engine payload with `configMode: true, boxPx: state.snappedPx`. `state.snappedPx` is in **display-viewport space**. This is the boundary where space conversion must happen.
- **Lines ~10158–10212** Tesseract fallback path — calls `cropCanvas(displayDataUrl, finalBox)` with no scale translation. Silently assumes the box and the image are in the same space.
- **Lines ~15618–15697** `paintWfg4StructuralOverlay` — draws using `getScaleFactors()` (display rect), not `pageEntry.scale`. Fixed in P1, not P0.
- **Lines ~15805–15842** `renderWfg4CanonicalIntoViewer` — swaps `els.pdfCanvas.width/height` to working dims, giving the "second render" feel and introducing the space divergence.
- **Lines ~15895–15903** `getScaleFactors()` — reads `src.getBoundingClientRect()`. Third source of truth for scale. Do not use for engine/overlay paths; UI only.
- **Lines ~19737–19900** confirm click handler — prelim `registerFieldConfig`, main `extractFieldValue`, persistence. The readiness gate and space conversion land here.
  - **19763–19786** prelim `registerFieldConfig` call; `catch` at 19786 silently swallows `captureStatus: 'artifact_missing'` / `'cv_unavailable'` from `wfg4-registration.js:102–106`.
  - **19828–19831** `storedBoxPx` resolved against `state.pageViewports[pageNum-1]` — the wrong space for downstream OpenCV/OCR.
  - **19843–19851** existing 96343f3 instrumentation — already logs `displayCanvas`, `wfg4SurfaceDims`, `viewport`, `storedBoxPx`, `normBox`. Use this as the acceptance signal.

### `engines/wfg4/wfg4-registration.js`

- **Lines 47–52** `packet.bbox` / `packet.bboxNorm` persistence — `bbox` should be in working space; currently it round-trips through `resolveCanonicalBox(normBox, pageEntry, pageNumber)` which is correct only if `normBox` was computed against working dims.
- **Lines 88–106** `ensureCvReady` + `artifact_missing` / `cv_unavailable` exit — returns a packet the caller does not inspect. Must be surfaced.

---

## 3. The `CaptureFrame` Definition

The `CaptureFrame` is the unifying object that eliminates coordinate-space ambiguity. It is constructed **once** when the user begins drawing (or at latest when Confirm fires, as a transitional shim) and is threaded through every subsequent call that touches geometry.

### Requirements

**Identity**
- `pageNum: number` — 1-based page number it describes.
- `sourceType: 'image' | 'pdf-text-layer' | 'pdf-scanned-or-empty'`.
- `generation: number` — monotonic counter bumped whenever `pageEntry` is re-normalized; used to detect stale frames.

**Spaces (dimensions only, no live DOM refs)**
- `display: { width: number, height: number }` — the pixel dims of the display canvas *at the moment the box was drawn*. Captured from `state.pageViewports[pageNum-1]` at construction time. Frozen.
- `working: { width: number, height: number }` — `pageEntry.dimensions.working`. Frozen.
- `scale: { workingFromDisplayX: number, workingFromDisplayY: number }` — derived at construction (`working.width / display.width`, `working.height / display.height`). Single transform used everywhere.

**Artifacts**
- `workingImageDataUrl: string` — reference to `pageEntry.artifacts.displayDataUrl`. Frozen. All crops come from this.
- `pageEntryRef: PageEntry` — for downstream code that needs PageStructure, etc. Treated as read-only.

**The box**
- `userBoxDisplayPx: Box` — the literal bbox the user drew, in display space. Kept for audit/debug.
- `userBoxWorkingPx: Box` — the same box translated into working space via `scale`. **This is the authoritative box** for all engine/OpenCV/Tesseract operations.
- `userBoxNorm: Box` — normalized [0..1] against working dims. Used for persistence + runtime reconstruction.

**Readiness invariants (must all be true before a `CaptureFrame` is valid)**
1. `state.wfg4.configSurface` exists and has a `pages[pageNum-1]` entry.
2. `pageEntry.dimensions.working` is populated.
3. `pageEntry.artifacts.displayDataUrl` is populated.
4. `ensureCvReady()` has resolved.
5. `pageEntry.pageStructure` is populated (Phase 1 complete).

If any invariant fails, the CaptureFrame cannot be built and Confirm must be blocked with a user-visible message (or queued behind a spinner).

**API sketch**
```js
// Construction — may throw / return null if invariants fail
buildCaptureFrame({ pageNum, userBoxDisplayPx, state })

// Conversions — pure, no side effects
captureFrame.toWorking(boxOrPointInDisplay) -> Box
captureFrame.toDisplay(boxOrPointInWorking) -> Box
captureFrame.toNormalized(boxInWorking) -> Box
captureFrame.fromNormalized(normBox) -> Box // working px

// Crop — the only sanctioned way to get OCR input
captureFrame.cropWorkingImage(boxInWorking) -> Canvas|DataUrl
```

**Rules**
- No engine code may read `state.pageViewports`, `state.viewport`, or `els.pdfCanvas.width` directly once CaptureFrame exists. Engine code consumes only the frame.
- `state.pageViewports` becomes UI-only (draw-time snapping).
- `getScaleFactors()` becomes UI/overlay-only and must not feed engine paths. (Overlay is rewritten in P1 to also route through CaptureFrame.)
- Every persisted field record carries the working-space bbox and the normalized bbox. Display-space bboxes are never persisted.

---

## 4. Phased Roadmap

### Short term — P0 (this session)
1. Convert `state.snappedPx` to working space at confirm; use that working-space box uniformly through `extractScalar` and the Tesseract crop.
2. Fix `cropCanvas` scale translation so the box and the image it is cropping from are guaranteed to be in the same space. Box is in working space, image is `displayDataUrl` which is in working space → trivial if step 1 is done.
3. Readiness gate on confirm: check `state.wfg4.configSurface`, `pageEntry.dimensions.working`, `pageEntry.artifacts.displayDataUrl`, `ensureCvReady()`. Rethrow prelim registration errors instead of swallowing them. User-visible feedback when not ready.
4. Keep existing 96343f3 instrumentation; extend it to log `pageEntry.scale` and the converted working-space box alongside the display-space box.
5. Acceptance test: on one image, one scanned PDF, one text-layer PDF — draw around a visible word, confirm, assert extracted text equals the word.

### Short term — P1 (next, not in this session)
6. Rewrite `paintWfg4StructuralOverlay` to transform via `pageEntry.scale` / CaptureFrame instead of `getScaleFactors()`. Overlay and extraction must share the math.
7. Extend overlay to draw the actual localized/reconstructed box and the config bbox in distinguishable colors.
8. Remove `needsLocalizedReadout` branch from the config-authoritative path — config should OCR its own literal crop explicitly.
9. Decide on `instances[]` / `repeatedConstellationPolicy === 'multi'`: promote to real feature or delete the dead branch at `wfg4-localization.js:601`.

### Medium term
10. Introduce `WorkingBox` typed wrapper with a space tag; migrate call sites incrementally.
11. Split `captureFieldFromUserBox()` (config) from `extractFieldAtRuntime()` (run) so they stop sharing branchy code.
12. Add a generation counter on `pageEntry` and assert it in `captureVisualReferencePacket` to catch stale-structure races.
13. Add a semantic validator after Phase 6 reconstruction: OCR the reconstructed box, compare against a stored prototype token/type, reject obviously-wrong reconstructions.
14. Deskew the working surface in the prepass so Phase 6 doesn't have to model rotation.
15. Persist the literal grayscale field crop bytes in `packet.visualReference.fieldCrop` for use as a runtime template.

### Long term (optional redesign)
16. Replace pure-geometry anchor selection with hybrid geometric + content-feature scoring (reuse ORB descriptors already computed for Phase 3).
17. Add homography / perspective path (`cv.findHomography` + RANSAC) to Phase 6 for scanned documents with skew.
18. Reconsider per-field constellations vs per-template page fingerprint + field offset; the current model rebuilds per field what is really a document-class property.
19. If still not good enough on realistic variance: lightweight learned component (small CNN or embedding model) used only for anchor scoring and semantic validation. Keep the rest of the structural pipeline.

---

## 5. Invariants that must not regress

- Text-layer PDF extraction must remain correct. The `tokensInBox` rescue path is not to be altered in P0/P1.
- `configModeAuthoritative` (`wfg4-engine.js:443–455`) must remain — the user's literal bbox is authoritative in config mode. P0 only ensures it is expressed in the correct space.
- `buildPageStructure` / Phase 1 output is a shared prepass between config and runtime. Do not split it.
- Refine-only drift clamp in Phase 7 (ORB as nudge, not relocator) stays.

---

## 6. Open questions for future agents

- Should `state.pageViewports` be deleted entirely or kept as a UI-only convenience? Current plan: keep but forbid engine access.
- Is `cv.findHomography` worth the integration cost given OpenCV.js bundle size? Open.
- Do we need a per-document-class "template registry" on top of per-field constellations, or can we get there incrementally? Open.
