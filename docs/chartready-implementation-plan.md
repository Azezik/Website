# ChartReady Implementation Proposal (No Code Changes Yet)

## Scope Guardrail
ChartReady should be implemented as a **strictly additive layer** that starts from an already-produced MasterDB CSV payload and emits derived chart artifacts. It must not modify wizard config, extraction, MasterDB generation, or upstream profile behavior.

## Where ChartReady Logic Should Live

### 1) New engine module: `chart-ready.js`
Create a standalone browser/Node-compatible utility module (same style as `master-db.js`) that owns all deterministic CSV -> chartready transforms:
- header/alias resolution
- required-column validation
- row parsing/normalization
- invalid date tracking
- dedupe (`doc_id`, last occurrence wins)
- stable sort (`event_date` asc, `doc_id` asc)
- dataset generation
- run summary generation

Recommended public API:
- `ChartReady.fromCsvText(csvText, options?)`
- `ChartReady.fromRows({ header, rows }, options?)`
- `ChartReady.toChartJsSeries(result)` (if you want a tiny adapter layer)

Reasoning: the repository already isolates export logic in a focused utility (`master-db.js`) and keeps orchestration/UI in `invoice-wizard.js`; ChartReady should follow that split.

### 2) UI orchestration in `invoice-wizard.js`
Wire button click handlers and persistence in `invoice-wizard.js` (same place as Wizard Manager actions and MasterDB export flow).

### 3) UI markup in `document-dashboard.html`
Add a ChartReady subsection under Wizard Details, directly below the existing first action row (Edit/Add Template/Export/Delete), with:
- `Generate`
- `Upload`
- `Refresh`
- hidden file input for CSV upload
- chart mount + summary/error mount

## Existing MasterDB / CSV Utilities to Reuse

## Reuse directly
1. **MasterDB rows hydration for a wizard**
   - `getOrHydrateMasterRows(user, docType, wizardId)` already returns canonical `{ header, rows }` for current wizard context.
   - Use this as the Generate/Refresh source (instead of rebuilding extraction data).

2. **CSV serialization for “Generate” parity with download mental model**
   - `MasterDB.toCsvRows(payload)` already serializes `{ header, rows }` deterministically.
   - Generate should obtain wizard rows via `getOrHydrateMasterRows(...)`, serialize to CSV text, then pass into ChartReady parser (in-memory), matching spec language (“exactly as if user was about to download it”).

3. **Wizard context resolution**
   - `resolveExtractedWizardContext()` gives active wizard/docType for extracted artifacts and should be reused for ChartReady target wizard.

4. **LocalStorage namespace pattern via `LS`**
   - Existing `LS` methods (`dbKey`, `rowsKey`, `batchLogKey`) establish naming pattern under `accounts.<user>.wizards.<docType>.<wizardId>.*`.
   - Add chartready keys in this same utility object for consistency and easy cleanup.

5. **Existing upload UI pattern**
   - Reuse the hidden file input + button-trigger pattern used for wizard import/upload actions in `invoice-wizard.js`.

## Reuse with small extension
1. **Backup/restore support**
   - `buildBackupPayload` / `applyRestorePayload` should include ChartReady derived artifacts so wizard details remain portable.

2. **Delete/reset cleanup**
   - `clearWizardArtifacts` and `deleteWizardEverywhere` should remove ChartReady derived artifacts alongside MasterDB artifacts.

## New Files / Modules Needed

1. `chart-ready.js` (new)
   - Pure deterministic engine.
   - No DOM.
   - Exposes parse/validate/dedupe/sort/dataset build.

2. `test/chart-ready.test.js` (new)
   - Required columns missing -> readable error listing missing columns.
   - Alias map behavior (minimal deterministic aliases only).
   - Money coercion: `$`, commas, spaces, parentheses negatives.
   - Invalid dates excluded from time-series and counted in summary.
   - Dedupe rule: last occurrence wins.
   - Sort rule: `event_date`, then `doc_id`.
   - Dataset omission of null Y values.
   - YTD dataset only if present + at least one numeric value.

3. Optional: `docs/chartready-contract.md` (new)
   - freeze the accepted canonical columns + alias map + output shape.

## Storage Shape for Derived Artifacts

Add LS helpers in `invoice-wizard.js`:
- `chartReadyKey(u,d,wizardId)` -> `accounts.<u>.wizards.<d>[.<wizardId>].chartready`
- `chartReadyRunKey(u,d,wizardId)` (optional if separating large artifacts and summary)

Recommended artifact payload:
```json
{
  "version": 1,
  "createdAt": "ISO",
  "source": "generate|upload|refresh",
  "schema": {
    "canonicalColumns": ["event_date","money_in","money_out","gross_or_total","ytd_total","doc_id"],
    "aliasesUsed": {"Doc ID":"doc_id"}
  },
  "summary": {
    "totalRowsRead": 0,
    "rowsUsed": 0,
    "rowsExcludedInvalidEventDate": 0,
    "dedupeCollisionsResolved": 0
  },
  "invalidRows": [
    { "rowIndex": 0, "reason": "invalid_event_date", "event_date_raw": "...", "doc_id": "..." }
  ],
  "events": [
    { "event_date":"2025-01-01", "event_date_display":"01/01/2025", "money_in":123, "money_out":null, "gross_or_total":400, "ytd_total":null, "doc_id":"abc" }
  ],
  "datasets": {
    "money_in": [{"x":"2025-01-01","y":123}],
    "money_out": [],
    "gross_or_total": [],
    "ytd_total": []
  }
}
```

## Generate / Upload / Refresh Wiring in Wizard Manager UI

## Placement
On Wizard Details page (`#wizard-details`), add ChartReady section beneath existing button row:
- row 1: existing wizard actions
- row 2: ChartReady controls (`Generate`, `Upload`, `Refresh`)
- then summary/errors/charts region

## Button behaviors (exact mapping)

1. **Generate**
   - Resolve wizard context.
   - Pull existing master rows with `getOrHydrateMasterRows(...)`.
   - Serialize to CSV with `MasterDB.toCsvRows(...)`.
   - Run `ChartReady.fromCsvText(csv)`.
   - Persist returned artifacts under wizard (`LS.setChartReady(...)`).
   - Render summary + charts from persisted result.

2. **Upload**
   - Open file picker (CSV only).
   - Read selected CSV text.
   - Run same ChartReady engine path as Generate.
   - Persist artifacts under wizard.
   - Render summary + charts.

3. **Refresh**
   - Call same flow as Generate (hard alias).
   - Intended after new docs update MasterDB rows.

## Rendering
Use Chart.js in details panel only (no impact to other tabs):
- `Money In over time`
- `Money Out over time`
- `Gross/Total over time`
- `YTD Total over time` only if dataset has at least one point

If validation fails (missing required columns):
- show readable error with missing column list
- do not render datasets
- keep upstream untouched

## Minimal Deterministic Alias Map (V1)
Keep tiny + explicit to remain deterministic:
- `event_date`: `event_date`, `Event Date`, `Invoice Date`, `Pay Date`, `Deposit Date`
- `money_in`: `money_in`, `Money In`, `Cash In`
- `money_out`: `money_out`, `Money Out`, `Cash Out`
- `gross_or_total`: `gross_or_total`, `Gross`, `Invoice Total`, `Total`
- `ytd_total`: `ytd_total`, `YTD`, `YTD Total`
- `doc_id`: `doc_id`, `Doc ID`, `File ID`

(If multiple aliases exist simultaneously, prefer exact canonical name first, then first alias in static list.)

## Determinism Notes (Important)
- `doc_id` fallback for blank values should be deterministic hash from normalized row content + original row index string.
- Deduping rule is positional: iterate input order and overwrite by `doc_id` so last wins.
- Sorting always by parsed date asc, then `doc_id` lex asc.
- Dataset generation should be pure projection (`x=event_date`, `y=column`) and skip null y-values.

## Incremental Rollout Sequence
1. Add engine + tests.
2. Add storage keys + cleanup + backup/restore integration.
3. Add Wizard Details ChartReady UI controls.
4. Add chart renderer + run summary/error panel.
5. Add one smoke test in UI harness if available.

