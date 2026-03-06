# Wrokit Architecture Compliance Audit

## 1. How the System Actually Works (End-to-End)

The system is a client-side JavaScript application running entirely in the browser. Its real pipeline is:

**Config Mode (actual flow):**
1. A PDF is loaded via PDF.js (`pdfjsLib`). Tokens are extracted from the PDF text layer by `readTokensForPage()`, which calls `page.getTextContent()` and transforms coordinates using the PDF.js viewport transform.
2. The user draws bounding boxes on a canvas overlay. Mouse events produce CSS-space coordinates, which are converted to pixel coordinates via `getScaleFactors()` (separate `scaleX`/`scaleY` values).
3. `snapToLine()` aligns the box to nearby OCR tokens.
4. Anchor metrics (`anchorMetricsFromBox`) are computed: four edge distances (top/left/right/bottom from the BBOX to page edges) plus a text pixel height estimate.
5. The OCR Magic Pipeline (`runOcrMagic`) runs the extracted text through a four-station correction chain: Layer-1 adjacency substitution → type-direction correction → per-slot learned scoring → fingerprint-guided correction. Scores are persisted in `localStorage`.
6. A keyword constellation is captured (`KeywordConstellation.captureConstellation`) around the field's top-left corner, recording the nearest 5 tokens and their pairwise deltas in normalized coordinates.
7. A visual ring-landmark fingerprint is recorded for each field — edge patches from a canvas crop of the region — for pixel-level fallback.
8. The assembled field spec (normBox, anchorMetrics, keywordConstellation, landmark, fingerprints) is serialized and saved to the profile store (currently `localStorage` or Firebase, depending on `isSkinV2`).

**Run Mode (actual flow):**
1. The profile is loaded verbatim from storage.
2. A new PDF is loaded. `ensureTokensForPage()` calls `readTokensForPage()` for PDF.js tokens; `ensureTesseractTokensForPage()` calls `readImageTokensForPage()` for full-page Tesseract tokens.
3. Source selection (`resolveExtractionTokensForField`): if PDF.js returns >0 tokens, use PDF.js. If PDF.js returns 0 tokens, fall back to Tesseract. **There is no richer decision logic.**
4. For each static field, the extraction pipeline runs:
   - Denormalize the stored normBox to pixel coordinates on the run document.
   - Find candidate tokens inside or near the scaled BBOX.
   - Score candidates: keyword-index distance, anchor metric check (`anchorMetricsSatisfied`, requiring ≥2 edge distances to match within tolerance), data-washing fingerprint check, line-count diff.
   - If the best candidate score is insufficient and a ring-landmark exists, attempt `matchRingLandmark()` as a fallback.
   - Extract the best candidate's text; run it through `FieldDataEngine.clean()` (which calls `runOcrMagic`).
5. For dynamic fields (line items), `buildColumnRowBands()` detects row boundaries from the anchor column, then `getColumnCellTokens()` extracts each column within each row band.
6. The extracted records are compiled via `compileRecord()` (in `engines/core/compile-engine.js`): field map assembled, totals consistency bonus applied, line items enriched.
7. On Confirm, compiled records are written to MasterDB.

**Modularization status:** Ten refactoring stages have extracted sub-modules into `engines/` and `adapters/`. However, the core extraction logic — the full 18 000-line `invoice-wizard.js` — still drives all execution. The new `EngineExtraction.orchestrate()` provides a coordination shell whose stage functions are all still implemented inside the monolith and passed in as closures. The adapter layer (`adapters/legacy/extraction-runtime.js`) is a single-line pass-through to `EngineExtraction.createExtractionEngine()`.

---

## 2. Architecture vs. Implementation Comparison

### Fully Implemented

| Described Component | Implementation Status |
|---|---|
| PDF.js text-layer token extraction | Fully implemented (`readTokensForPage`, coordinate transform via `Util.transform`) |
| Tesseract full-page OCR | Fully implemented (`readImageTokensForPage`, two variants including one with robust bbox handling) |
| Edge Relation Anchors (≥2 match required) | Fully implemented (`anchorMetricsSatisfied`, `anchorMatchForBox`); requires `min(2, available)` matches |
| Text Pixel Height as scale check | Implemented as part of `anchorMetricsFromBox` and used in `anchorMetricsSatisfied` |
| Ring-landmark visual fingerprint | Fully implemented (`ring-landmark.js`, `matchRingLandmark`, edge ZNCC comparison) |
| OCR Magic Pipeline (data washing) | Fully implemented — four-station pipeline in `ocr-magic-pipeline.js`; more sophisticated than the 5-test description |
| Dynamic row extraction (row bands + column mapping) | Fully implemented (`buildColumnRowBands`, `getColumnCellTokens`) |
| Keyword Constellation Engine — capture | Fully implemented (`constellation-engine.js`, `captureConstellation`) |
| Keyword Constellation Engine — match scoring | Fully implemented (`matchConstellation`, cross-link scoring) |
| Area System / AreaFinder | Substantially implemented (`areafinder.js`, `area-scoping.js`, `captureAreaConstellation`, `matchAreaConstellation`, `findAreaOccurrencesForPage`) |
| MasterDB record model | Implemented (`master-db.js`; HeaderRecord + LineItemRecord structure with normalization) |
| Width-first coordinate scaling | Implemented via normBox/denormBox; the `anchorMetricsSatisfied` function uses proportional distances |
| Compile Engine | Fully implemented (`compile-engine.js`; totals consistency, line enrichment, chartability) |
| Trace / debug infrastructure | Extensively implemented (`trace.js`, OCR trace hooks, static debug logging) |

### Partially Implemented

| Described Component | Gap |
|---|---|
| `selectGeometry` / multi-geometry support | The orchestration shell accepts it optionally; the call site sets it to `null` in many flows. Multi-geometry is partially wired but not always active. |
| Wizard persistence (saving + dropdown) | Architecture names this a known defect. Code paths exist for both Firebase and `localStorage` but the saving/dropdown regression is unresolved. |
| Width-first alignment enforcement | Normalization happens correctly for static fields; the Δ% >10% dynamic-region layout mismatch check is implemented in field-level logic but there is no top-level single "layout mismatch gate" that halts processing before any field extraction begins. |
| Snapping hardening (mitigation tasks 1–6) | Width capping (task 2) is present in `snapToLine`. Symmetric scale enforcement and aspect-ratio validation fallback (tasks 1, 3) are not implemented as described. Debug tracing (task 5) is extensive but not the canonical path described. |
| Configuration version stored with MasterDB rows | `compileRecord` accepts `templateKey` / `snapshotManifestId` but these are not guaranteed to be populated at the call site. |
| Idempotency / duplicate handling | Referenced in design; no concrete deduplication logic found in `master-db.js`. The policy (reject vs. merge vs. version) is not implemented. |

### Conceptual but Not Operational

| Described Component | Actual Status |
|---|---|
| Constellation as run-mode extraction fallback | Captured and stored, used in Find Text debug UI and visual-run overlay, but **not wired into the static extraction fallback chain**. The main fallback chain goes: anchor + fingerprint check → ring-landmark → in-box token fallback. Constellation is not in this chain. |
| "Fail cleanly" LAYOUT_MISMATCH as a hard gate | The three error categories (LAYOUT_MISMATCH, OCR_FAILURE, VALIDATION_FAILURE) are referenced in comments but there is no single enumerated error type structure or global halt mechanism. Failures result in empty/low-confidence field values, not a structured early exit. |
| Reporting from MasterDB only (no PDF reprocessing) | MasterDB write path is implemented; reporting read path (`chart-ready.js`) exists; but how the UI reloads from MasterDB after confirm is not verifiable as a closed loop without runtime testing. |
| Auto-email ingestion, sales-rep mode, ONNX/TensorRT OCR | Not implemented; listed as future hooks. |

### Implemented Differently Than Described

| Architecture Description | Actual Implementation |
|---|---|
| "5-test yes/no Data Washing Fingerprint code" | A slot-by-slot, session-accumulated, learned character-type system with PCS (Pattern Consistency Scoring). Far more sophisticated than the described 5-digit binary code, and also more expensive. |
| "Data washing fingerprint learned from most common observed" | Fingerprints are learned incrementally across multiple runs via `SegmentModelStore` in `localStorage`. They are not "batch-computed at config time" — they grow with each pass through `runOcrMagic`. |
| "Landmarking fingerprint: tiered best-match full → left half → right half" | Implemented correctly in `matchRingLandmark` with `half` parameter, but the threshold tuning (0.75 full, 0.60 half) is fixed in the engine, not configurable per-field. |
| Keyword Constellation: "origin = top-left of BBOX" | Implemented as `origin = { x: normBox.x0n, y: normBox.y0n }` — matches spec. But the "double-check anchor choice" flag noted in the architecture was never resolved; the origin is always top-left. |
| "Constellation proposed geometry must still pass edge anchors + data washing" | The constellation in `engines/findtext/constellation-engine.js` returns a `predictedBoxPx` but this is only used in the Find Text UI. No integration with the anchor validation gate was built for run-mode extraction. |

---

## 3. Hierarchical Pipeline Coordination

**Where it works:**

The extraction engine shell (`EngineExtraction.orchestrate`) provides a correct linear pipeline: load → tokenize → [select geometry] → [area rows] → static fields → post-check → line items → compile. Stage outputs are threaded forward. The post-check gate (`hasExtractedContent`) is a meaningful quality gate before line-item extraction runs.

The OCR Magic pipeline is correctly hierarchical: Layer-1 corrections feed Layer-2 type-direction corrections, which feed Layer-3 learned scoring, which feed Layer-4 fingerprint application. Each station is a pure transformation.

**Where it breaks down:**

1. **Fallback chain is not end-to-end.** The architecture says: anchor match → pixel height → data washing → landmark. In practice: anchor and fingerprint checks produce a score multiplier that reduces confidence but does not force a different candidate. The landmark is invoked if the candidate set is empty or if no candidate passes a threshold. The constellation is never invoked in this chain. This means the design's "tiered precision recovery" degrades into a continuous confidence adjustment rather than discrete escalation.

2. **No top-level layout gate.** The architecture requires a pre-extraction orientation check and global width/height ratio check that aborts cleanly on failure. This does not exist as a pipeline stage. Instead, individual field extractions produce low-confidence outputs when geometry drifts too far. The document is never formally rejected at the entry point.

3. **Config and Run share mutable state.** Both modes write to `state.*` and read from it. The boundary between "config is complete" and "run mode reads config verbatim" is enforced by code paths, not by data ownership. This creates coupling risk: a partially configured wizard can be in state when run mode begins.

4. **Stage functions are closures over global state.** The new engine contracts inject stage functions, but those functions close over `state`, `els`, and module-level globals. The architectural modularity is structural (calling conventions), not operational (data isolation).

---

## 4. PDF.js vs. Tesseract Decision Logic

### The actual decider (line 16775–16812):

```javascript
// auto mode:
const pdfTokens = await ensureTokensForPage(page);
if (Array.isArray(pdfTokens) && pdfTokens.length) {
  return buildResult(pdfTokens, 'pdfjs', 'pdfjs', 'pdf_tokens_available');
}
const tessTokens = await ensureTesseractTokensForPageWithBBox(page);
return buildResult(normalized, 'tesseract', 'tesseract-bbox', 'pdf_empty_tokens_fallback', 'pdfjs');
```

The decision is: **count > 0 → use PDF.js; count === 0 → use Tesseract.** That's the entire heuristic.

### Why this fails for half-filled PDFs:

A half-filled PDF contains a printed template layer (vendor header, labels, column headings) and user-filled values that were either:
- Written into PDF form fields that the PDF viewer does not expose via `getTextContent()` in the same token stream, or
- Overlaid as a scan/image layer.

In either case, `getTextContent()` returns the template tokens (non-zero count), so the decider routes everything to PDF.js. The user-filled values appear nowhere in the PDF.js token stream. When the static extraction pipeline searches for, say, an invoice number at the stored BBOX location, it finds template label text instead of the actual number. Fingerprint checking may reject this, leaving the field empty — but the system does not escalate to Tesseract because the source selection already committed to PDF.js.

**Tesseract in this context would see the full rendered pixels**, including both the template text and the user-filled values, and would produce tokens for both. For this class of document, Tesseract is the correct primary source, not the fallback.

### What a correct decider would look like:

The decider should evaluate **field-level adequacy**, not page-level count. A useful heuristic:
- Run PDF.js. For each field BBOX, check how many non-template tokens (i.e., tokens not matching stored template keywords) fall in the region.
- If the field BBOX returns zero non-label tokens, that field should be tried with Tesseract.
- A hybrid extraction strategy: use PDF.js coordinates for field location, Tesseract tokens for field content extraction in ambiguous BBOXes.

The current architecture assumes the two paths are mutually exclusive at the page level. For half-filled PDFs they must be mixed at the field level.

### Consistency after the decision:

Once a source is chosen, the two branches do NOT behave identically:

- **PDF.js tokens** have exact coordinates in viewport space, sub-pixel accuracy, confidence = 1.0 for all tokens.
- **Tesseract tokens** have bounding boxes in canvas pixel space. There are TWO different implementations: `readImageTokensForPage` (uses `w.bbox?.x`) and `readImageTokensForPageWithBBox` (uses `getTesseractWordBBox(w)` which is more robust). The full-page Tesseract path uses PSM 6 without fallback. The crop-based path tries PSM 6 and 7 and picks the better result.
- The `normalizeTesseractTokensForPage()` function applies a page-offset subtraction to Tesseract tokens to align them to the page-relative coordinate space. If page offsets are miscalculated, Tesseract tokens will be systematically shifted.
- Anchor validation (`anchorMetricsSatisfied`) compares edge distances. For Tesseract tokens, the canvas pixel coordinates must match the viewport pixel coordinates. If `renderScaleX ≠ renderScaleY` (which happens when the canvas aspect ratio diverges from the viewport), Tesseract bounding boxes will be stretched relative to what the anchor validation expects.

---

## 5. Mirroring of Extraction Pipelines

The two pipelines converge on a shared token format `{x, y, w, h, text, confidence, page}` and share the same downstream logic (keyword scoring, anchor checking, OCR magic, landmark). This convergence is architecturally correct. However, several asymmetries undermine reliability:

| Dimension | PDF.js | Tesseract |
|---|---|---|
| Coordinate space | Page viewport space (logical points) | Canvas pixel space; normalized by `normalizeTesseractTokensForPage` |
| Confidence | Always 1.0 | Per-word confidence from Tesseract (0–1) |
| Token granularity | Word-level items from PDF text stream | Word bounding boxes from Tesseract |
| Full-page vs. crop OCR | N/A — always full text content | Two separate implementations (with/without robust bbox fix) |
| PSM strategy | N/A | PSM 6 only for full-page; PSM 6+7 for crop |
| Coordinate normalization | Built into the PDF.js transform pipeline | External post-processing step; page-offset-dependent |
| Duplicate implementations | One `readTokensForPage` | Two: `readImageTokensForPage` and `readImageTokensForPageWithBBox` — different bbox extraction code |
| Integration maturity | Primary, extensively tested | Secondary, fewer safeguards; known source of reliability issues |

**Assessment:** The Tesseract branch is structurally mirrored but operationally weaker. The duplicate full-page OCR implementations (`readImageTokensForPage` vs `readImageTokensForPageWithBBox`) are a maintenance hazard — they can produce different coordinate results for the same document, and the system does not consistently pick one over the other. The bbox-fixed version exists precisely because the original was unreliable, but both remain in use.

---

## 6. Keyword Constellation Engine

### Is it implemented?

Yes. `engines/findtext/constellation-engine.js` is a complete, well-structured implementation. `captureConstellation` finds the nearest 5 tokens around the field origin, records their normalized positions and pairwise deltas (`anchorDelta`, cross-links). `matchConstellation` scores candidate anchor instances by comparing expected vs. actual deltas, accumulates edge match counts, and returns a ranked list with `predictedBoxPx`.

`tools/keyword-constellation.js` is a thin wrapper that wires in the `KeywordWeighting` normalizer.

### Is it integrated into fallback extraction?

**No.** The constellation is:
1. Captured during config mode and stored on the field spec (`fieldSpec.keywordConstellation`).
2. Used in the Find Text debug panel (`buildFindTextConstellationBoxes`) to visually highlight supporting tokens.
3. Used in the visual run overlay (`buildVisualRunConstellationBoxes`, `updateVisualRunOverlay`) for display.
4. Stored in config mode during the visual run step (line 1368–1378).

It is **not invoked in the main static extraction pipeline** (`extractFieldValue` / the field-level scoring loop). The fallback chain in run mode goes: scored candidates → anchor check → ring-landmark → in-box text fallback. Constellation is not a step in this chain.

### Does config mode capture the right data?

Yes. The captured constellation stores the anchor token's text, center coordinates, and field-delta (distance from field origin to anchor token center), plus up to 4 support tokens with their cross-links. This is sufficient to relocate a field if geometric drift occurs.

### Does run mode use it effectively?

No. The `predictedBoxPx` from `matchConstellation` is computed but only displayed, never used as a BBOX proposal for the extraction engine to re-attempt field location with.

### Is it redundant with other mechanisms?

Somewhat. The ring-landmark already provides a visual patch-based fallback. The constellation provides a token-relationship-based geometric fallback. These are complementary (one is pixel-based, one is semantic-geometric), but since neither is connected to the other in a deliberate escalation chain, there is no coordination between them.

The constellation is the right idea for handling geometric drift in scanned documents. For half-filled PDFs specifically, it would provide better field relocation than the current approach — but only if the tokens found by the extraction source (PDF.js or Tesseract) include the anchor tokens expected by the constellation. For PDF.js on a half-filled PDF, the anchor tokens (e.g., "Invoice #") may be present, but the field value token is missing, making constellation-based relocation incomplete without also switching token sources.

### Conclusion on constellations:

The engine is **well-implemented but ineffectively integrated**. It functions as a development visualization tool rather than an operational extraction fallback.

---

## 7. Smoothness of End-to-End System Logic

### Disconnected assumptions:

1. **The extraction engine orchestrator assumes stage functions are provided by the caller.** The stage functions (`prepareTokens`, `extractStaticFields`, etc.) are closures over the monolith's state. The engine shell provides calling-convention structure but not actual separation. The architecture describes clean module boundaries; the implementation has monolith internals dressed in module clothing.

2. **The constellation assumes it will be used as a fallback (per architecture §11.5), but the extraction pipeline does not call it.** This is the clearest assumption-gap in the system: the constellation was designed to propose candidate bounding boxes for re-extraction, but nothing in the extraction pipeline invokes `matchConstellation` to get a new BBOX.

3. **The layout mismatch gate assumes it will halt processing, but it does not exist as a gate.** Individual fields produce low confidence; no top-level "reject this document" decision is made. A run on a wrong-template document produces a compiled record with empty fields rather than a structured failure.

4. **OCR Magic fingerprints assume they are learned in Config Mode and applied in Run Mode.** In practice, fingerprints accumulate across all runs (config and run mode). A first run with a new wizard has no prior learning; the fingerprint correction pass is ineffective. The architecture implies fingerprints are calibrated during config; they are actually emergent across time.

5. **The snapping system assumes scaleX == scaleY.** The code separately divides by `scaleX` and `scaleY`, and the documented instability (§9.3) arises directly from `max-width: 100%` causing different X and Y scaling. Width-capping in `snapToLine` partially mitigates this, but the full hardening plan (symmetric scale enforcement, aspect ratio validation) is not implemented.

### Unused or ineffective logic:

- `selectGeometry` optional stage in the orchestrator: not wired in practice.
- `applyTotalsConsistency` in `compile-engine.js` applies a ±0.05/−0.2 confidence delta when subtotal + tax ≈ total. This is a useful cross-check but is too small to alter routing decisions.
- `ocrBox()` (crop-based Tesseract with dual PSM probing) is well-designed but only invoked in the raw-data config-mode path, not in run-mode field extraction.

### Brittle assumptions:

- Anchor metrics are computed using `state.pageViewports` which are set during PDF loading. If the viewport changes (e.g., zoom) between config and run, coordinate projections diverge.
- `state.tessTokensByPage` and `state.tessTokensByPageBBox` are separate caches for the two Tesseract variants. A run that switches between them mid-session may use stale data.
- The `resolveExtractionTokensForField` function is used in find-text mode. But the main run-mode field loop calls `ensureTokensForPage` directly (not via this resolver), bypassing the auto-fallback logic entirely in many field-level paths.

---

## A. How the System Currently Works (Summary)

Wrokit is a client-side, template-guided PDF extraction system. In Config Mode, users annotate a template PDF, generating per-field descriptors: edge anchors, visual ring-landmarks, OCR-magic fingerprints, and keyword constellations. In Run Mode, a new PDF is loaded, PDF.js extracts its text layer, each field's stored geometry is de-normalized and searched for candidate tokens, multi-signal validation scores each candidate, and the best value is extracted and written to MasterDB.

The system is largely functional for well-scanned, text-layer PDFs. Its reliability degrades for scanned images (where Tesseract must carry the load) and for half-filled PDFs (where the PDF.js/Tesseract decision logic routes to the wrong source).

---

## B. Where the Implementation Diverges

1. **Constellation not integrated as a fallback** — the most significant gap between architecture and implementation.
2. **No top-level layout mismatch gate** — the system never formally rejects a document; it produces degraded output instead.
3. **OCR Magic fingerprint is emergent/runtime-learned**, not config-time-calibrated as the architecture implies.
4. **PDF.js/Tesseract decider is a binary count check** — not the field-level adequacy check the half-filled PDF problem requires.
5. **Snapping hardening plan is partially implemented** — width capping exists; symmetric scale enforcement and aspect-ratio validation do not.
6. **Wizard persistence defect is unresolved** — acknowledged in the architecture, still present.
7. **Duplicate Tesseract full-page implementations** with different bbox extraction code — architecture implies one Tesseract branch.

---

## C. Most Important Architectural Weak Points

1. **PDF.js/Tesseract source selection is wrong for half-filled PDFs.** This is the highest-impact architectural flaw. The binary "count > 0 → PDF.js" rule is inadequate. A field-level hybrid strategy is needed.

2. **Constellation engine is a dead-end.** An entire subsystem was built to enable geometric drift recovery, but it does not participate in extraction. All the config-mode capture work produces data that only feeds a visualization.

3. **No formal layout mismatch gate.** The architecture's central quality promise — "fail cleanly rather than inferring" — is not operationally enforced. Wrokit currently infers on wrong-template documents rather than rejecting them.

4. **Tesseract coordinate pipeline has two divergent implementations.** `readImageTokensForPage` and `readImageTokensForPageWithBBox` are inconsistent; the latter exists because the former was unreliable, but both are active.

5. **The modularization shell wraps but does not isolate.** The new engines call back into the monolith through closures. The architectural boundary exists on paper but not in data flow.

---

## D. Issues Specifically Affecting Tesseract Reliability

1. **Duplicate full-page OCR functions.** `readImageTokensForPage` uses `w.bbox?.x` directly; `readImageTokensForPageWithBBox` uses `getTesseractWordBBox(w)` with a more robust extraction. Both are active in different code paths. If the system selects the wrong one, bounding boxes will be systematically wrong.

2. **Canvas coordinate vs. viewport coordinate mismatch.** Tesseract returns pixel coordinates on the rendered canvas. If the canvas render scale differs from the PDF viewport logical scale (which it does when the canvas element has CSS-constrained dimensions), token coordinates will be displaced. `normalizeTesseractTokensForPage()` applies a page offset subtraction but does not correct for render scale drift.

3. **PSM 6 only for full-page extraction.** PSM 6 assumes a uniform block of text. Invoices with multi-column layouts, sparse fields, or large empty regions may produce poor Tesseract output. The crop-based path (`ocrBox`) tries both PSM 6 and PSM 7 and picks the better result — this adaptive approach is not applied to the full-page extraction path.

4. **No confidence filtering on Tesseract tokens.** PDF.js tokens all get confidence = 1.0. Tesseract tokens have per-word confidence but this is not used to filter low-confidence words before they enter the extraction pipeline. This can introduce noise in anchor matching and fingerprint checks.

5. **Anchor validation calibrated against PDF.js geometry.** The stored `anchorMetrics` are built from the config-mode PDF.js viewport coordinates. When Tesseract is the run-mode source, the token positions must exactly replicate those coordinates for anchor validation to pass. Any systematic offset (from render scale, canvas sizing, or page offset errors) will cause anchor validation failures across all fields simultaneously, not just one.

6. **`tesseractSkippedAlignFail` counter exists but is not acted upon.** The stats tracker counts alignment failures but there is no circuit-breaker that switches strategy when too many fields fail Tesseract alignment.

---

## E. Whether Keyword Constellations Are Actually Useful

In the current architecture: **minimally**. They are useful as a development visualization (showing which tokens surround a field match in Find Text mode) but do not contribute to extraction outcomes.

In the intended architecture: **yes, they would be high-value** — specifically for the half-filled PDF problem. If a field's primary BBOX location fails (because user-filled content is not at the expected coordinate after drift), the constellation could use surrounding template text (which IS in the PDF.js token stream) to re-anchor the BBOX. This is particularly powerful because template text is always present and consistent, while user-filled content may drift.

To make constellations operationally useful, two things are needed:
1. Wire `matchConstellation` into the static extraction fallback chain after anchor-check failure. The matched `predictedBoxPx` becomes the new search region.
2. Ensure the constellation tokens come from the same source as the extraction tokens. If using PDF.js for constellation matching (template text) but Tesseract for value extraction (user content), this requires a hybrid token pool — which the current architecture does not support.

---

## F. Highest-Value Improvements (Least Invasive First)

### Priority 1: Deduplicate the Tesseract full-page OCR path
**What:** Replace all calls to `readImageTokensForPage` with `readImageTokensForPageWithBBox` (or one canonical wrapper). Update `ensureTesseractTokensForPage` to always use the bbox-fixed version. Deprecate the unfixed version.
**Why:** Eliminates a class of Tesseract coordinate bugs with minimal code change. No architectural impact.
**Risk:** Low.

### Priority 2: Add PSM 6+7 probing to full-page Tesseract
**What:** Apply the `runOcrProbes`/`chooseBestProbe` pattern (already used in crop-based OCR) to the full-page Tesseract path. Choose the result with more tokens or higher confidence.
**Why:** Improves Tesseract output quality for all non-ideal document layouts without changing any other logic.
**Risk:** Low; performance slightly higher (two recognize calls per page).

### Priority 3: Add Tesseract confidence filtering
**What:** Filter Tesseract tokens with `w.confidence < threshold` (e.g., 40%) before storing in `tessTokensByPage`. Tune threshold empirically.
**Why:** Reduces noise tokens that cause false anchor matches and bad fingerprint scoring. Improves precision without changing the extraction algorithm.
**Risk:** Low; some words will be silently dropped but high-confidence words will be more reliable.

### Priority 4: Implement a top-level layout mismatch gate
**What:** Before field extraction, check: (a) page orientation matches stored profile, (b) page width is within ±10% of template width, (c) the token count is not zero (OCR_FAILURE). If any check fails, set a `layoutMismatch` flag, skip extraction, and return a structured failure with reason.
**Why:** Fulfills the architecture's core "fail cleanly" invariant. Prevents garbage output on wrong-template uploads.
**Risk:** Medium — must ensure the tolerance is appropriate. Start conservative (15% tolerance) to avoid false rejections.

### Priority 5: Fix the PDF.js/Tesseract source decision for half-filled PDFs
**What:** After PDF.js extraction for a field, check whether the tokens in the field BBOX include any non-label content (i.e., tokens not matching stored template keywords). If the BBOX contains only label tokens or zero value-candidate tokens, mark that field for Tesseract re-extraction. Build a per-field source override map that the extraction loop respects.
**Why:** This is the highest-impact reliability improvement for the stated class of problem. Current routing is wrong for this common case.
**Risk:** Medium-high. Requires defining "template-only" vs "has user content" heuristics. Can be introduced with a flag and tested on known half-filled documents before enabling broadly.

### Priority 6: Wire the constellation engine into the extraction fallback chain
**What:** In the static field extraction loop, after anchor-check failure and before ring-landmark, call `matchConstellation(fieldSpec.keywordConstellation, tokens, ...)` if a constellation is stored. If a match is returned with `matchedEdges >= 2`, use `predictedBoxPx` as the new search region and re-run the candidate scoring pass.
**Why:** Makes the constellation operationally useful for the first time. Particularly effective when template text is present (PDF.js path) and the field location has drifted geometrically.
**Risk:** Medium. The constellation match tolerance (currently 0.01 normalized) must be validated against real documents. Recommend a shadow mode first: log constellation predictions vs. actual extractions without acting on them.

### Priority 7: Implement the snapping hardening plan
**What:** Enforce symmetric scale computation in `getScaleFactors()` (single scale from width ratio, not separate X/Y). Add aspect-ratio validation in `snapToLine`: if snapped box aspect ratio is <0.1 (too thin) or >20 (too wide), reject the snap and fall back to the user's raw selection box.
**Why:** Resolves the documented root cause of snapping instability in Config Mode. All subsequent signals (anchors, constellations, landmarks) are derived from snapped boxes; bad snaps propagate forward.
**Risk:** Medium. Symmetric scale may change the position of overlays in existing sessions. Recommend a migration test before rolling out.

### Priority 8: Make OCR Magic fingerprint calibration deterministic at config time
**What:** During the config mode field confirmation step, run `runOcrMagic` with a "learn" mode and serialize the resulting `SegmentModelStore` records into the wizard profile. In run mode, load the stored records into a fresh `SegmentModelStore` (not the shared `defaultSegmentStore`) so each wizard has isolated fingerprint state.
**Why:** Fixes the assumption gap where config-time fingerprints are supposed to calibrate run-time correction. Currently both modes share the same store and fingerprints accumulate across all users/wizards.
**Risk:** High. Requires changes to how `SegmentModelStore` is constructed and where its data is persisted. Best done in a dedicated refactoring pass.
