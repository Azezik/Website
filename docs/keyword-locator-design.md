# Keyword-Assisted Static-Field Locator Design

## 1. Current OCR and Token Handling
- **Page tokenization during CONFIG/RUN:** `ensureTokensForPage` pulls PDF text items via `readTokensForPage` and caches them per page in `state.tokensByPage`; images short-circuit to an empty array (no OCR).【F:invoice-wizard.js†L4401-L4434】
- **CONFIG selection flow:** When the user draws a box, `finalizeSelection` snaps the box to nearby tokens using `snapStaticToLines`/`snapToLine`, storing `state.snappedPx`, `state.snappedText`, and optional line metrics for later extraction.【F:invoice-wizard.js†L4688-L4736】
- **CONFIG confirmation:** `extractFieldValue` in CONFIG static mode (`method: config-permissive`) simply reads tokens inside the snapped box (or uses `StaticFieldMode.extractConfigStatic` if present) and stores the resulting tokens plus ring landmarks/line metrics in the profile via `upsertFieldInProfile`. No OCR is triggered here unless the optional OCR self-test is toggled.【F:invoice-wizard.js†L2865-L2911】【F:invoice-wizard.js†L5720-L5784】
- **Optional OCR crop self-test:** If the “Run OCR on confirm” toggle is enabled, `auditCropSelfTest` calls `getOcrCropForSelection`/`runOcrProbes` to OCR the just-confirmed box, but this is for diagnostics only and does not feed the extraction pipeline.【F:invoice-wizard.js†L5720-L5763】
- **RUN-mode ordering for static fields:** `extractFieldValue` executes: (1) bbox transform + attempt (snap, assemble lines, clean/fingerprint/line-count) with small padding retries; (2) landmark-assisted search (full/partial ring in CONFIG, anchorAssist in RUN); (3) `labelValueHeuristic`; (4) fallback to snapped text; (5) optional `RunLandmarkOnce.maybeBoostWithLandmark` confidence scaling. Anchors are enforced when present via `anchorMatchForBox` checks around each candidate.【F:invoice-wizard.js†L3061-L3170】
- **No full-page OCR lattice:** There is no cached OCR token structure for images or PDFs beyond PDF text extraction. `ocrBox` exists but is unused for full-page passes. To support keyword indexing we need a reusable page-level token lattice generated once per page (PDF text tokens or OCR tokens for images) and cached in `state.tokensByPage`/`page-level keyword index` for both CONFIG and RUN.

## 2. Keyword Scan at CONFIG Upload
- **Timing (render-pipeline anchored):** Once `renderAllPages` has finished and all visible pages have run through `ensureTokensForPage`, call `buildKeywordIndexForPage(page)` for each page. This must complete before Question #1, positioning keyword scanning immediately after document render and before any selection/confirmation work.
- **Source tokens:** Reuse the existing page tokens (`state.tokensByPage[page]`). For images, introduce a fallback to a one-time full-page OCR pass (Tesseract) to populate tokens, storing results in `state.tokensByPage` so downstream steps share them.
- **Keyword catalogue:** Curated map shaped like `{ categoryKey: { en: [keywords...], fr: [keywords...] } }` (or equivalent) covering static fields (invoice_number, invoice_date, store_name, customer_address, subtotal_amount, tax_amount, invoice_total, payment_method, payment_status, etc.). Initial implementation can populate only `en`, but the structure must allow adding `fr` later for Québec invoices without changing the algorithm.
- **Scan logic overview:** See §3 for the full-page scan algorithm. At a high level, the keyword scan should run once per rendered page using the tokens already loaded.
- **Keyword BBOX record:** `{ page, bbox: {x,y,w,h}, keyword, category, fontHeight: token/line h }` (bbox normalized or pixel + viewport ref).
- **Storage:** Add `state.keywordIndexByPage[page] = [keywordBboxes...]` as a runtime-only cache built from tokens after `ensureTokensForPage`; it is reused during the current CONFIG/RUN session but is not persisted into the saved profile/template. Persisted configs only store per-field `keywordRelations` captured at confirmation time.
- **Hook point:** After `ensureTokensForPage` is invoked during `renderAllPages`/`renderImage`, call `buildKeywordIndexForPage(page, tokens, viewport)` once and store the index; guard to avoid re-scanning.

## 3. Full-Page Keyword Scan Algorithm (How to Build Keyword BBOXes)
- **Inputs:**
  - Tokens from `ensureTokensForPage` (PDF text) or tokens from a one-time Tesseract full-page OCR pass (images) cached into `state.tokensByPage`.
  - Keyword catalogue `{ categoryKey: { en: [...], fr: [...] } }` keyed by category and language.
- **Steps:**
  1. **Normalize text:** Lowercase token text and strip obvious punctuation for matching while preserving the original text for logging.
  2. **Optionally group into lines:** Use `groupIntoLines(tokens, viewport)` (or equivalent) to form line objects with joined text and union bboxes; keep both raw tokens and grouped lines available.
  3. **Iterate candidates:** For each token and each line, check lowercased text for substring matches against every keyword string in the active language list (start with `en`).
  4. **Merge contiguous hits:** When a multi-token phrase matches, merge contiguous tokens/line segments into a unified keyword bbox (min x/y, max x+y+h) to avoid fragmented boxes.
  5. **Capture font-height proxy:** Record the height of the token/line bbox as `fontHeight` for later compatibility scoring.
  6. **Normalize bbox:** Store both pixel bbox and normalized bbox (dividing by page width/height) for reuse across DPI/viewbox changes.
  7. **Emit keyword entry:** For each match, emit `{ page, bboxPx, bboxNorm, keyword, category, fontHeight }` into `state.keywordIndexByPage[page]`.
- **Invocation:** `buildKeywordIndexForPage(page)` performs the above once per page immediately after render (post-`ensureTokensForPage`) and is reused later without rescanning.

## 4. Capturing Relations per Static Field During CONFIG
- **Trigger:** Inside the CONFIG confirm handler after `extractFieldValue` returns but before `upsertFieldInProfile` persists data.【F:invoice-wizard.js†L5720-L5784】 The relation between a static field and its mother keyword must be captured during that field’s confirmation step, using the already-built keyword index. This ensures offsets remain template-stable and page-specific.
- **Inputs:**
  - Field value bbox (`boxPx`) and normalized bbox (`normBox`).
  - Page keyword index (`state.keywordIndexByPage[page]`), never rescanned here.
  - Field metadata (fieldKey → category mapping; anchor metrics already captured).
- **Mother keyword selection:**
  1. Filter keyword BBOXes whose category matches the field’s category map.
  2. Score candidates with weighted components:
     - Positional preference: highest weight if keyword bbox is left of the value bbox with y-overlap; fallback to above if none on the left.
     - Distance: negative penalty proportional to center-to-center distance; cap search radius (e.g., 20–30% of page width/height).
     - Font-size compatibility: small penalty if keyword height deviates >50% from value bbox height.
  3. Pick highest-scoring candidate as “mother”. If none, leave keyword relations empty.
- **Secondary keywords:** Select up to 3 remaining scored candidates (K = 3) within a reasonable radius; store their offsets for triangulation.
- **Stored config payload (per static field):**
  - Normalized field bbox (already saved).
  - Anchor metrics, ring landmark, line metrics (existing behavior).
  - `keywordRelations` object:
    - `mother`: `{ text, category, normBox, offset: {dx,dy,dw,dh}, score }` where offset is relative (value bbox minus keyword bbox normalized by page dims).
    - `secondaries`: array of up to 3 entries (K = 3) with the same shape as mother.
    - `page` to ensure page-specific association when fields are reprojected.
- **Persistence:** Extend `upsertFieldInProfile` extras for static fields to include `keywordRelations`; save these per-field relations (mother + up to 3 secondaries, offsets, scores, page) alongside `landmark`/`lineMetrics`. The per-page `keywordIndexByPage` cache remains runtime-only and is never persisted.

## 5. RUN MODE Integration
- **Base flow preserved:** Keep existing bbox → ring/landmark/anchor → OCR/text assembly → fingerprint/line scoring sequence intact.【F:invoice-wizard.js†L3061-L3170】
- **Rebuild/lookup keyword BBOXes:** Before extracting each static field, ensure `state.keywordIndexByPage[page]` exists; if absent, build it from cached tokens (PDF text) or run the one-time full-page OCR for that page (images only) and cache.
- **Mother keyword check:** Locate keywords in the index matching the stored category and (optionally) similar text. Compute expected keyword box by applying inverse offsets: from keyword bbox plus stored `offset` to predict the value bbox location. If multiple matches, choose the one minimizing distance between predicted bbox and current base bbox.
- **Scoring with keyword relations:**
  - After base candidate selection, compare candidate bbox to predicted bbox from mother keyword. Compute a `keywordWeight` (e.g., 0.9–1.2) that boosts confidence when centers are close and relative size matches; decay to 1.0 when far. Cap to only positive reinforcement (never <0.8).
  - For weak anchor/ring cases, optionally generate an additional predicted bbox from mother (or triangulated from secondaries averaged) and run a lightweight attempt confined near that box; treat any candidate found as supplemental with low base confidence but allow keywordWeight to lift if aligned.
  - Final confidence: `result.confidence = clamp(baseConfidence * keywordWeight, 0, 1)` unless landmark boost already applied; if both apply, multiply sequentially but cap at 1.
- **Failure behaviors:**
  - **Mother not found:** Skip keyword weighting (keywordWeight = 1).
  - **Mother found but offset inconsistent (beyond radius):** Skip weighting; optionally log `[static-debug] keyword mismatch`.
  - **No catalogue hits:** Skip weighting entirely.
  - **Strong anchor/fingerprint:** If anchors and fingerprint already high, keywordWeight should max at neutral+small bonus to avoid overriding solid matches.

## 6. Scope
- Apply keyword scanning and weighting **only** to static scalar fields (store_name, department_division, invoice_number, invoice_date, salesperson_rep, customer_name, customer_address, subtotal_amount, discounts_amount, tax_amount, invoice_total, payment_method, payment_status). Column/line-item fields continue to use the existing landmark/anchor/table logic without keyword inputs.

## 7. Debug Facility
- Extend `static-debug` logging to include keyword diagnostics alongside existing entries in `extractFieldValue`:
  - Log detected keywords per page and indicate chosen mother/secondaries for the target field, stored offsets, predicted bbox, computed `keywordWeight`, and final confidence after weighting.
  - During overlay debug rendering (when `flags.ocr`/static debug is on), optionally draw keyword bboxes in a distinct color and annotate mother/secondary links.
  - Insert logging where `keywordRelations` are applied in RUN mode (after base candidate chosen, before confidence scaling) to mirror current debug statements around anchors/fingerprints.【F:invoice-wizard.js†L3063-L3170】

## 8. Required Refactors and Ordering Separation
- **Step 1:** Keyword scanning happens once per page immediately after initial render (post-`ensureTokensForPage` during `renderAllPages`), before any configuration questions.
- **Step 2:** Field-to-keyword relation mapping happens each time the user confirms a static field. These two steps stay decoupled so that keyword indexes remain reusable and field relations are captured exactly at confirmation time.
- Implement a reusable full-page OCR path for images to populate `state.tokensByPage` once per page; reuse for both keyword indexing and extraction (avoiding repeated OCR crops).
- Add keyword index cache (`state.keywordIndexByPage`) with builder functions reusable in CONFIG and RUN.
- Extend profile field extras to persist `keywordRelations` captured during CONFIG (mother + up to 3 secondaries, offsets, scores, page), while keeping the keyword index runtime-only.

## 9. How Codex Should Detect Incorrect Assumptions in Future Revisions
- **Expose inferences:** Whenever behavior is inferred (e.g., assuming a hook or timing), call it out explicitly instead of silently adopting it.
- **Show ordering reasoning:** When pipeline ordering could be ambiguous, explain the assumed order and why; ask for confirmation if unsure.
- **Ask clarifying questions when:**
  - A feature relies on functions whose behavior is not fully described (e.g., assuming `groupIntoLines` handles rotated text).
  - A timing hook or event trigger is assumed (e.g., expecting a callback after `renderAllPages`).
  - Reusing an existing pipeline step without explicit confirmation (e.g., expecting `ensureTokensForPage` to run for images after adding OCR).
- **Potential assumption points in this pipeline:**
  - Assuming `renderAllPages` always calls `ensureTokensForPage` for every visible page before Question #1.
  - Assuming `groupIntoLines` exists and returns union bboxes suitable for keyword merging.
  - Assuming the one-time Tesseract pass will be available for images and cached identically to PDF tokens.
  - Assuming keyword catalogue language selection (e.g., defaulting to `en`) without a locale flag.
  - Assuming normalization of bboxes (pixel vs. normalized) follows the same conventions as existing landmark storage.
- **Goal:** Prevent silent invention of sequencing or hooks; surface uncertainties early so the pipeline remains explicit and verifiable.
