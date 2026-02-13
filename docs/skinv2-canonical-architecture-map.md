# WROKIT SkinV2-First Canonical Architecture Map

## 1) SkinV2-first architecture summary + call graph

### Canonical runtime order (SkinV2)
1. **SkinV2 boot / entrypoint**
   - `index.html` (`body.skin-v2`) loads `js/session.js`, `js/home-login.js`, and Firebase module wiring.
   - Login (`performLogin`) writes `wiz.session` via `SessionStore.setActiveSession(...)` and redirects to `/document-dashboard.html` with username/docType query params.
2. **Auth / session hydration**
   - `document-dashboard.html` loads `invoice-wizard.js` + Firebase/session utilities.
   - `invoice-wizard.js` reads `sessionBootstrap = SessionStore.getActiveSession()` and seeds `state.username`, `state.docType`, `state.activeWizardId`.
   - `completeLogin(...)` is the runtime gate that finalizes active user/docType/wizard and re-persists `SessionStore`.
3. **Context selection (wizard + geometry context)**
   - `resolveSelectedWizardContext()` / `resolveRunWizardContext()` determine the active wizard + geometry and load profile via `loadProfile(...)`.
   - Wizard selection UI paths: model select (`custom:*`), Wizard Manager, or restored session value.
4. **Config flow**
   - `configure-btn` in SkinV2 opens Wizard Manager/builder (`openNewWizardFromDashboard`), then config UI.
   - In wizard confirm path (`confirmBtn` handler): `extractFieldValue(...)` + `upsertFieldInProfile(...)` + `saveProfile(...)`-backed profile mutations.
   - Static config captures landmarks/keyword relations/line metrics for future run extraction.
5. **Run flow**
   - Dropzone / file input call `processBatch(files)`.
   - `processBatch` resolves run context (`resolveRunWizardContext`) and calls `runModeExtractFileWithProfile(...)` per file.
   - Run mode loads doc tokens (`openFile`, OCR/PDF token resolvers), iterates fields via `extractFieldValue(...)`, extracts line items via `extractLineItems(...)`.
6. **Compile flow**
   - `compileDocument(fileId, lineItems)` consolidates rawStore field outputs + line items + totals/confidence boosts + area payloads.
   - Persists to DB store (`LS.setDb(...)`) and refreshes Master DB row cache.
7. **UI tables / reports**
   - `renderResultsTable()` for extracted data table.
   - `renderReports()` for reporting view.
   - `renderSavedFieldsTable()` for wizard-side review/edit pane.

### SkinV2 call graph (high-level)
`index.html (skin-v2)`
→ `home-login.js: performLogin()`
→ `SessionStore.setActiveSession()`
→ redirect `document-dashboard.html`
→ `invoice-wizard.js bootstrap`
→ `completeLogin()`
→ `resolveSelectedWizardContext()` / `resolveRunWizardContext()`
→ **Configure path**: `openNewWizardFromDashboard()` → wizard confirm → `extractFieldValue()` → `upsertFieldInProfile()`
→ **Run path**: `processBatch()` → `runModeExtractFileWithProfile()` → `extractFieldValue()` + `extractLineItems()`
→ `compileDocument()`
→ `renderResultsTable()` + `renderReports()` (+ `renderSavedFieldsTable()`).

---

## 2) Legacy architecture call graph (legacy-only labeled)

### Legacy-only entry and routing
- Legacy user entry is explicit (`/legacy/`), guarded by `legacy-gate.js` (`markLegacyEntry`, `requireLegacyFlag`).
- `legacy/invoice-wizard.html` loads the **same** `invoice-wizard.js` engine file, but without SkinV2 shell and with legacy tabs/layout.

### Legacy call graph
`legacy/index.html`
→ `legacy-gate.js: markLegacyEntry()`
→ `legacy/invoice-wizard.html`
→ `legacy-gate.js: requireLegacyFlag()`
→ `invoice-wizard.js bootstrap` (runs with `isSkinV2 === false`)
→ legacy defaults (`DEFAULT_WIZARD_ID`, legacy dashboard tabs, legacy configure button behavior)
→ configure/run pipeline still goes through shared core (`extractFieldValue`, `extractLineItems`, `compileDocument`, `renderResultsTable`).

### Legacy-only behavior markers
- **Legacy-only route shell**: `/legacy/*` pages and top nav.
- **Legacy-only gate semantics**: `legacy-gate.js` session flag requirement.
- **Legacy-only default context posture**: fallback to `DEFAULT_WIZARD_ID` and legacy model-select behavior when `isSkinV2` is false.

---

## 3) Visual Run and Find Text (debug benches)

### Visual Run
**What it tests**
- Single-field end-to-end replay of config→run extraction logic.
- Token-source switching (`pdfjs` vs `tesseract`) against one selected field.
- Overlay + attempt snapshots for extracted raw/cleaned output and constellation diagnostics.

**What it bypasses**
- Does not run full multi-field batch pipeline or full compile-to-masterdb acceptance gates.
- Uses temporary visual-run template/wizard context rather than normal wizard-manager selection flow.

**Shared state it mutates (current)**
- `state.visualRun.*` (field/template/tokenSource/attempts/outputs/context stash).
- Global wizard context while active: `state.activeWizardId`, `state.activeGeometryId`, `state.steps`, `state.stepIdx`, `state.wizardComplete`.
- Shared document state: `state.pageNum`, `state.viewport`, `state.matchPoints`, `state.snappedPx` (read/write through extraction interactions).

### Find Text
**What it tests**
- Text-location and candidate ranking behavior for query matching.
- Comparison of PDF.js-token matching vs Tesseract-token matching.
- Optional constellation overlays and learning/feedback capture.

**What it bypasses**
- Does not execute profile-driven field extraction lifecycle (`extractFieldValue` per wizard step) as a full run.
- Does not compile/persist extracted records via `compileDocument`.

**Shared state it mutates (current)**
- `state.findText*` families (selection boxes, result sets, debug payloads, learning attempts, insights cache).
- Shared viewer state: `state.pageNum`, `state.viewport`, and overlay-highlight arrays used by global draw pipeline.
- Can influence subsequent overlay/debug context because it reuses the same viewer and token caches.

---

## 4) Canonical Engine Contract (single list)

This is the **canonical core engine surface** that all shells (SkinV2, Legacy, debug benches) should be treated as clients of.

1. **`resolveRunWizardContext(opts)`**
   - **Input:** selected wizard/model/docType context + optional profile override.
   - **Output:** `{ wizardId, geometryId, profile, selectionValue, selectionSource, displayName, ... }`.
2. **`ensureProfile(wizardId?, geometryId?)` + `loadProfile(username, docType, wizardId, geometryId)`**
   - **Input:** identity + wizard/geometry selectors.
   - **Output:** normalized profile (v3-compatible) with fields/landmarks/column metadata.
3. **`extractFieldValue(fieldSpec, tokens, viewport)`**
   - **Input:** field config (static/column/area metadata), page tokens, viewport dims.
   - **Output:** `{ value, raw, confidence, boxPx, correctionsApplied, tokens, ... }`.
4. **`extractLineItems(profile)`**
   - **Input:** active profile with configured columns and current doc token context.
   - **Output:** normalized row list with quantity/unit/amount coherence scoring.
5. **`compileDocument(fileId, lineItems)`**
   - **Input:** current raw field store keyed by `fileId` + extracted line items.
   - **Output:** compiled record `{ fields, invoice, totals, lineItems, areaOccurrences, masterDbConfig, warnings, ... }` and persisted DB write side effect.
6. **`runModeExtractFileWithProfile(file, profile, runContext)`**
   - **Input:** one file + hydrated profile + resolved run context.
   - **Output:** extraction side effects (rawStore + DB updates + traces), culminating in compile/finalize stages.
7. **Storage adapters (`LS.*`, `rawStore.*`, save/load helpers)**
   - **Input:** username/docType/wizard/geometry scoped payloads.
   - **Output:** persisted profiles, run records, batch logs, and migration-safe versioned profile artifacts.

Contract expectation: UI layers may orchestrate these functions, but should not redefine extraction semantics outside this list.

---

## 5) Recommended documentation files to add (names + headings)

1. **`docs/canonical-entrypoint.md`**
   - `# Canonical Entrypoint: SkinV2`
   - `## User-facing route map`
   - `## Auth/session bootstrap order`
   - `## Why Legacy is non-canonical`

2. **`docs/engine-contract.md`**
   - `# Canonical Engine Contract`
   - `## Required function signatures`
   - `## Input/output invariants`
   - `## Allowed side effects`

3. **`docs/shells-and-clients.md`**
   - `# Shells and Clients of the Engine`
   - `## SkinV2 client`
   - `## Legacy client (compatibility only)`
   - `## Debug benches: Visual Run + Find Text`

4. **`docs/run-vs-debug-modes.md`**
   - `# Run Pipeline vs Debug Benches`
   - `## Production run stages`
   - `## Visual Run deviations`
   - `## Find Text deviations`
   - `## Shared mutable state map`

5. **`docs/legacy-boundary.md`**
   - `# Legacy Boundary`
   - `## Legacy-only routes and gates`
   - `## Shared engine components`
   - `## Explicit non-goals for legacy`
