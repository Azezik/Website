# ChartReady Grounded Implementation Plan (Design-Only, Additive)

## Scope and non-goals
- **Strictly additive**: no edits to extraction, wizard configuration flow, or MasterDB generation internals.
- ChartReady runs only from:
  1) existing MasterDB CSV generated from existing rows, or
  2) user-uploaded CSV.
- UI placement is fixed: **Wizard Manager → Wizard Details**, under the existing first action-row buttons.

## 1) Exact files to change (existing) and new files to add

### Existing files to change
1. `document-dashboard.html`
   - Add a ChartReady subsection container under `#wizard-details-actions` and before/alongside the existing log region.
   - Add a hidden CSV file input for Upload.
   - Add a chart mount region (4 canvases max) and summary/error region.
   - Add one Chart.js script include (if not already loaded).

2. `invoice-wizard.js`
   - Extend `els` with ChartReady element refs.
   - Extend `LS` with ChartReady keys/get/set/remove helpers.
   - Extend Wizard Details rendering to add **Generate / Upload / Refresh** below current action row.
   - Add orchestration handlers (Generate, Upload, Refresh).
   - Add Chart.js rendering + cleanup of chart instances.
   - Add backup/restore integration in existing payload functions.
   - Add delete/reset cleanup integration where wizard artifacts are removed.

### New files to add
1. `chart-ready.js`
   - Pure data-transform module (no DOM): parse CSV → normalize rows → compute chart payload + summary.
   - Browser global export style to match existing utility pattern (`master-db.js` style).

2. `docs/chartready-contract.md` (optional but recommended)
   - Freeze schema, alias map, confidence/error semantics for future changes.

3. `test/chart-ready.test.js` (if test harness supports it)
   - Deterministic cases for parsing, normalization, sorting, filtering, and dataset generation.

## 2) File-level diff strategy: sections/functions to edit and changes

## `document-dashboard.html`
### Existing anchors
- Wizard details section exists at `#wizard-details`, currently with:
  - `#wizard-details-actions`
  - `#wizard-details-log`

### Planned edits
- Add a new subsection directly under `#wizard-details-actions`:
  - Title: `ChartReady`
  - Buttons: `Generate`, `Upload`, `Refresh`
  - Hidden input: `type="file" accept=".csv,text/csv"`
- Add mounts:
  - `#chartready-summary`
  - `#chartready-errors`
  - `#chartready-charts` (contains canvases for Money In, Money Out, Gross/Total, YTD)

## `invoice-wizard.js`
### A) Element map (`els`) additions
- Add refs for new nodes:
  - `chartReadySection`, `chartReadyGenerateBtn`, `chartReadyUploadBtn`, `chartReadyRefreshBtn`, `chartReadyFileInput`, `chartReadySummary`, `chartReadyErrors`, `chartReadyCharts`.

### B) `LS` helper extensions (same namespace pattern)
- Add methods and keys:
  - `chartReadyKey(u,d,wizardId)`
  - `getChartReady(u,d,wizardId)`
  - `setChartReady(u,d,payload,wizardId)`
  - `removeChartReady(u,d,wizardId)`
  - Optional: `chartReadySourceKey(...)` if storing upload source metadata separately.

### C) Wizard details action rendering
- Existing function: `renderWizardDetailsActions()`.
- Keep current action row intact (`Edit`, `Add Template`, `Export Wizard`, `Delete`).
- Append ChartReady subsection **below first row**, not replacing it.
- Attach button handlers there.

### D) Generate / Upload / Refresh orchestration
- Generate flow:
  1. Resolve wizard/docType context using existing selection resolver.
  2. Get rows via `getOrHydrateMasterRows(user, docType, wizardId)`.
  3. Serialize using `MasterDB.toCsvRows(payload)`.
  4. Run `ChartReady.fromCsvText(csvText, options)`.
  5. Persist via `LS.setChartReady(...)`.
  6. Render summary/errors/charts.
- Upload flow:
  1. Trigger hidden file input.
  2. Read selected CSV text.
  3. Same transform/persist/render path as Generate.
- Refresh flow:
  - Alias of Generate, sourcing latest rows and replacing persisted artifacts.

### E) Chart rendering
- Add render functions that consume persisted ChartReady payload and draw default charts only:
  - Money In
  - Money Out
  - Gross/Total
  - YTD (only if at least one valid numeric point)
- Manage lifecycle:
  - destroy previous chart instances before redraw.

### F) cleanup integration points
- Extend `clearWizardArtifacts(username, docType, wizardId)` to remove ChartReady LS key(s).
- Extend `deleteWizardEverywhere(username, docType, wizardId)` to remove ChartReady LS key(s).
- Extend `wipeAllWizardData()` only indirectly through `localStorage.clear()` (already global), but still keep targeted remove methods for non-global paths.

### G) backup/restore integration points
- In `buildBackupPayload(username)` include ChartReady artifact under each `wizardEntry`.
- In `applyRestorePayload(payload)` restore ChartReady artifacts for each wizard.

## `chart-ready.js` (new)
### Contents
- CSV parser + canonical column resolver.
- Numeric coercion (`$`, commas, spaces, parentheses negatives).
- Date normalization to ISO date (`YYYY-MM-DD`) for x-axis.
- Per-row filtering: invalid date rows excluded from time-series but counted in summary.
- Deterministic dedupe by `doc_id` (last row wins).
- Stable sort by date asc, then `doc_id` asc.
- Build datasets for required default series.

## 3) Function signatures to add (no implementation yet)

## `chart-ready.js`
- `ChartReady.fromCsvText(csvText, options = {}) => ChartReadyResult`
- `ChartReady.fromRows(rowsPayload, options = {}) => ChartReadyResult`
- `ChartReady.resolveColumns(headerRow, options = {}) => ResolvedColumns`
- `ChartReady.buildDatasets(events, options = {}) => ChartReadyDatasets`

Suggested shapes:
- `rowsPayload: { header: string[], rows: Array<{ fileId?: string, cells: any[] }|any[]> }`
- `ChartReadyResult: {
    version: number,
    createdAtISO: string,
    source: 'generate'|'upload'|'refresh',
    summary: { totalRowsRead:number, rowsUsed:number, rowsExcludedInvalidEventDate:number, dedupeCollisionsResolved:number },
    errors: string[],
    warnings: string[],
    events: Array<{ event_date:string, doc_id:string, money_in:number|null, money_out:number|null, gross_or_total:number|null, ytd_total:number|null }>,
    datasets: { money_in: Point[], money_out: Point[], gross_or_total: Point[], ytd_total: Point[] }
  }`
- `Point: { x: string, y: number }`

## `invoice-wizard.js`
- `function createChartReadyControls(template){ /* returns HTMLElement */ }`
- `async function runChartReadyGenerate({ source = 'generate' } = {})`
- `async function runChartReadyUpload(file)`
- `function runChartReadyRefresh()`
- `function persistChartReadyArtifact({ username, docType, wizardId, artifact })`
- `function loadChartReadyArtifact({ username, docType, wizardId })`
- `function renderChartReadyPanel({ username, docType, wizardId })`
- `function renderChartReadyCharts(artifact)`
- `function clearChartReadyCharts()`

## 4) Generate / Upload / Refresh source, execution, persistence, rendering
- **Generate**: uses existing hydrated master rows (`getOrHydrateMasterRows`) + existing CSV serializer (`MasterDB.toCsvRows`), runs `ChartReady.fromCsvText`, persists to LS, renders.
- **Upload**: uses user CSV text directly, runs same ChartReady engine path, persists to LS, renders.
- **Refresh**: reruns Generate path and overwrites persisted artifact.
- Rendering reads from persisted artifact (single source of truth) to avoid UI/data drift.

## 5) Storage keys + cleanup/backup/restore alignment

### LS key pattern (consistent with existing)
- `accounts.<u>.wizards.<d>[.<wizardId>].chartready`

### Integration points
- Remove in:
  - `clearWizardArtifacts(...)`
  - `deleteWizardEverywhere(...)`
- Include in backup payload in `buildBackupPayload(...)` under each wizard entry:
  - `wizardEntry.chartReady = <artifact>` (if present)
- Restore in `applyRestorePayload(...)`:
  - if `data.chartReady` then `LS.setChartReady(...)`

## 6) Output dataset shape chosen for Chart.js
**Chosen shape: `[{x, y}]` points** for every series.
- Reason: natural time-scale compatibility and sparse-series support (no need to align labels arrays when fields are partially empty).

## 7) Default charts confirmation (no chart selection UI)
Only render these default charts:
1. Money In
2. Money Out
3. Gross/Total
4. YTD (render **only if** dataset contains at least one valid numeric point)

No user chart-picker UI is added in this phase.
