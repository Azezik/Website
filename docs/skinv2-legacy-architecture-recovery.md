# Skin V2 Legacy Architecture Recovery (Config → Run Scaffolding)

## Scope
This document reconstructs the **actual working Skin V2 pathways** needed to integrate a replacement extraction engine without redesigning the full product.

It focuses on:
- Config pathway (wizard setup)
- Run pathway (apply wizard to uploaded document)
- Wizard lifecycle and data model
- Current PDF.js/Tesseract integration points
- Concrete plug-in surface for a new extraction engine

---

## A) High-Level Product Flow (Config → Run)

### 1) App shell and mode surfaces
- `document-dashboard.html` is the Skin V2 shell: dashboard + run dropzone + Wizard Manager + engine selector (`legacy`, `ai_algo`, `wrokit_vision`).
- `invoice-wizard.js` is the runtime coordinator for both configuration and run mode state transitions.

### 2) Config pathway (what actually happens)
1. User opens wizard creation from dashboard (`openNewWizardFromDashboard`).
2. In Skin V2, user creates or edits a custom wizard template in builder (`saveBuilderTemplate`).
3. App switches to config mode (`activateConfigMode`), creates step sequence from selected wizard (`initStepsFromActiveWizard`).
4. User uploads a document (`openFile`) and draws field boxes.
5. On each field confirmation, app:
   - resolves tokens (PDF.js, with optional OCR fallback via token resolver),
   - captures geometry and metadata,
   - writes/updates field into active profile (`upsertFieldInProfile`),
   - persists profile (`saveProfile`).
6. After final step, wizard profile is marked configured and becomes reusable for run mode.

### 3) Run pathway (what actually happens)
1. User selects wizard context (`resolveRunWizardContext`) and drops files (`processBatch`).
2. App enters run mode (`activateRunMode`) and for each file calls `runModeExtractFileWithProfile`.
3. Extraction is executed through orchestration contract (`EngineExtraction.orchestrate`) with stage callbacks supplied by `invoice-wizard.js`:
   - `prepareRunDocument`
   - token preparation
   - geometry selection gate
   - area rows
   - static extraction
   - post-check
   - line item extraction
   - compile + persist
4. Final compiled record is saved to local DB (`LS.setDb`) and rendered in Extracted Data / Reports.

---

## B) Module / File Breakdown (Working Path)

## Entry/UI integration
- `document-dashboard.html` — Skin V2 tabs, wizard selection/dropzone, engine selector, PDF.js/Tesseract script wiring.
- `invoice-wizard.js` — primary orchestration file (mode control, config/run flows, extraction stage callbacks, persistence calls).

## Mode/state helpers
- `tools/wizard-mode.js` — mode constants (`CONFIG`, `RUN`, `LEARN`) and run-loop guard/diagnostics helpers.

## Storage and persistence
- `invoice-wizard.js` (`LS` object) — localStorage key strategy for profile/db/geometry metadata.
- `adapters/skinv2/profile-store.js` — Skin V2 profile adapter, cloud-sync-safe payload sanitization.
- `js/data/wizard-data-service.js` — Firestore-first + cache fallback service abstraction used by Skin V2 data layer.

## Engine contract + routing
- `engines/core/engine-registry.js` — engine type normalization and dispatch (`legacy`, `ai_algo`, `wrokit_vision`).
- `engines/core/extraction-engine.js` — orchestration contract (`orchestrate`) used in run mode.
- `adapters/legacy/extraction-runtime.js` — legacy runtime adapter currently wrapping `EngineExtraction`.

## Compile/output model
- `engines/core/compile-engine.js` — compiles extracted field map + totals checks + line item normalization.
- `master-db.js` — normalizes compiled records into table/report/export views.

---

## C) Wizard Lifecycle (Create → Save → Manage → Apply)

### 1) Create
- Wizard Manager/builder constructs template fields (static/dynamic/areabox) with constraints and normalized field keys.
- `saveBuilderTemplate` validates wizard name/fields, builds `masterDbConfig`, persists template, activates config mode.

### 2) Configure (field geometry capture)
- Step list comes from template (`initStepsFromActiveWizard`, `buildStepsFromTemplate`).
- Each step confirmation calls `upsertFieldInProfile`, storing normalized bbox + page + extraction metadata (anchor metrics, keyword relations/constellation, landmarks, column metadata, engine config).

### 3) Save
- `saveProfile` writes versioned profile payload to localStorage key scoped by user/docType/wizardId/geometryId.
- Geometry metadata index is maintained (`upsertGeometryMeta`) so multiple layouts are attached to one wizard.

### 4) Manage
- Wizard Manager list loads templates for current user/docType (`loadTemplatesForUser`, `renderWizardManagerList`).
- Model selector controls active wizard context and run-time routing.
- Preconfigured wizard imports are loaded from manifest and materialized into same template system.

### 5) Apply (Run)
- Run context resolved from selected wizard/model/profile (`resolveRunWizardContext`).
- Run mode reads profile by wizard+geometry context, then executes extraction pipeline per file.

---

## D) Data Models (Wizard, Fields, Geometry, Metadata)

## 1) Template model (builder-level)
Template shape is normalized by `normalizeTemplate` / `normalizeTemplateFields` and stored in `CUSTOM_WIZARD_KEY` list:
- `id`, `wizardName`, `documentTypeId`, `username`, `version`
- `fields[]` (name, fieldType, fieldKey, order, area relationships, magic type)
- `masterDbConfig`

## 2) Profile model (runtime extraction model)
`ensureProfile`/`migrateProfile` hydrate a profile containing:
- `version` (current migrations include engine + runtime policies + v3 compatibility)
- `wizardId`, `geometryId`, `docType`, `engineType`, `isConfigured`
- `fields[]` extraction specs and runtime-compatible metadata
- `tableHints` (column extraction guidance)
- `masterDbConfig`
- optional `wrokitVision` container (runtime-heavy artifacts stripped before persistence)

## 3) Field model (persisted from config)
`upsertFieldInProfile` writes per-field records including:
- identity: `fieldKey`, `type`, `fieldType`, `areaId`
- geometry: `bbox`, `bboxPct`, `normBox`, `page`, `configBox`, `rawBox`
- extraction output seed: `value`, `raw`, `confidence`, `tokens`, `correctionsApplied`
- behavior/meta: `magicDataType`, `engineType`, `anchorMetrics`, `keywordRelations`, `landmark`, `keywordConstellation`, `staticGeom`, `column`

## 4) Geometry model
- Profiles are scoped by `geometryId` in keyspace (`wiz.profile.<user>.<docType>.<wizardId>.<geometryId>`).
- Geometry catalog (`wiz.geometries...`) stores display name, created time, page size/aspect.
- Run path can probe/select among multiple geometry variants (`resolveGeometryIdsForReadPath`, `selectGeometryForRun`).

---

## E) Existing Extraction Integration (PDF.js + Tesseract)

## 1) Document/token ingestion
- `openFile` / `prepareRunDocument` ingest PDF/image.
- PDF path uses PDF.js rendering and `readTokensForPage` (`getTextContent` transformed to viewport coordinates).
- Tesseract full-page path uses `readImageTokensForPageWithBBox`; `readImageTokensForPage` now delegates to this robust bbox parser.

## 2) Source selection and fallback
- `resolveExtractionTokensForField` decides token source (`pdfjs`, `acroform`, or Tesseract fallback when PDF text is empty).
- In static extraction loop, there is explicit extra fallback for half-filled PDFs: if PDF-based extraction returns empty, retry with Tesseract tokens for that page.

## 3) Extraction stage wiring in run mode
Within `runModeExtractFileWithProfile`, stage callbacks passed into `EngineExtraction.orchestrate` do the real work:
- static field extraction (`extractFieldValue` loop)
- area-row extraction (`extractAreaRows`)
- line items (`extractLineItems`)
- compile (`compileDocument`)

## 4) Where current approach breaks down
- Core execution still depends on monolithic `invoice-wizard.js` closures; modular shell exists but most logic is still tightly coupled to shared state.
- Multiple token modalities (PDF.js/acroform/Tesseract) are resolved at runtime with several branch points, increasing drift risk across file types.
- Engine routing exists, but legacy path remains dominant operationally; replacement engine must interoperate with existing profile/data contracts first.

---

## F) Where a New Extraction Engine Should Plug In

## Recommended insertion point (minimal product disruption)
Preserve UI + wizard/profile lifecycle. Replace field extraction internals behind existing contracts.

### 1) Keep these stable boundaries
- Wizard config UX and template/profile persistence.
- Run mode orchestration call shape (`EngineExtraction.orchestrate`).
- Compile/output contracts (`compileDocument` / MasterDB).

### 2) Replace/augment inside these interfaces
- `extractFieldValue(fieldSpec, tokens, viewport)` implementation path.
- Token-resolution policy (`resolveExtractionTokensForField`) to support normalized visual input and per-field strategy.
- Geometry selection confidence gate (`selectGeometryForRun`) using stronger structure matching.
- Optional engine registration payload (`EngineRegistry.registerFieldConfig`) for config-time feature capture.

### 3) Integration contract for the new engine
New engine should accept existing field specs and return at minimum:
- `{ value, raw, confidence, tokens, correctionsApplied, engineUsed, tokenSource, extractionMeta }`
so downstream rawStore/compile/report flows remain unchanged.

### 4) WFG3-inspired normalization (without changing product flow)
Adopt a normalized viewport/token surface **inside** token provider/extraction layers, not by replacing Wizard Manager or run UX.

---

## G) Strong / Reusable Parts

1. **Product shell and user flow are solid**
   - Dashboard → wizard manager → configure → run → extracted data/report loop is already coherent.

2. **Wizard lifecycle and persistence model are rich**
   - Templates, profile versioning, geometry variants, field metadata, and migration pipeline already exist.

3. **Run orchestration contract exists**
   - `EngineExtraction.orchestrate` gives a clear sequential pipeline that can host a new extraction core.

4. **Compile/output side is reusable**
   - Field map compilation, totals cross-checks, line-item enrichment, and MasterDB/report wiring are in place.

5. **Engine-type routing already present**
   - `engine-registry` and field config hooks let a replacement engine coexist during migration.

---

## H) Weak / Replaceable Parts

1. **Monolithic coordination in `invoice-wizard.js`**
   - Core path is functionally correct but tightly coupled and difficult to evolve safely.

2. **Extraction consistency across file types**
   - PDF.js/Tesseract/acroform branch behavior still depends on runtime heuristics that can be brittle on mixed-content docs.

3. **Engine layering is partial**
   - Orchestration is modular; implementations are still mostly legacy closures over global state.

4. **Field extraction internals are the main replacement target**
   - This is the right place to introduce bbox-first micro-expansion, stronger confidence ranking, and normalized visual abstraction.

---

## Practical Scaffolding Plan (No Implementation Yet)
1. Freeze current UI + persistence contracts.
2. Define an internal “field extraction adapter” boundary under `extractFieldValue`.
3. Implement new engine behind `engine-registry` as opt-in engine type while preserving rawStore + compile outputs.
4. Migrate static fields first, then column fields, then geometry-selection improvements.
5. Keep run-time A/B capability (legacy vs new engine) through existing engine selector.
