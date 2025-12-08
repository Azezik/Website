# MasterDB DBSEED Handling and Custom Header Injection Notes

## DBSEED discovery and static-only fallback
- **Where to detect DBSEED=0:**
  - `selectMajorityRows()` computes `dynamicCounts` via `summarizeDynamicCounts()` and derives the majority row count through `computeMajorityRowCount()` before any filtering happens. If all dynamic item keys are blank, `computeMajorityRowCount` returns `null`, effectively a DBSEED of 0, while `selectMajorityRows` still returns the original items and the zeroed `dynamicCounts` for downstream use.
- **Where logic lives in `flatten()`:**
  - `flatten` builds `allItems` from the selected items, then immediately runs `inferLineCalculations`, `computeUsableRows`, and `synthesizeLineNumbers` to finalize usable row count and line numbering. This is the first point where the effective row count (post-majority selection and inference) is known and before any synthetic rows are added.
  - The existing totals-based synthetic row insertion sits right after these counts (`usableRowCount`, `syntheticLineNo`) are computed and before the integrity logging / empty-input guard.
- **How and where to insert the static-only synthetic row:**
  - Hook immediately after the totals-based synthetic row branch, but before the integrity logging and `usableRowCount === 0` throw. This keeps the fallback adjacent to other synthesis, yet isolated from totals-mode behavior.
  - When `dynamicCounts` (from `selectMajorityRows`) indicate DBSEED=0 and `usableRowCount` is still 0 after inference, inject a single item into `allItems` (and its parent `entry.items`) that carries only static header fields. Do **not** reuse or mutate the totals-based path to avoid coupling to subtotal/total availability.
- **Required conditions for the static fallback:**
  - Trigger only when `computeMajorityRowCount` produced `null` / DBSEED=0 (no dynamic columns) **and** `usableRowCount` remains 0 after synthesis.
  - Skip if any dynamic line items are present (normal behavior) or if the totals-based synthetic row already produced a usable line (leave existing flow unchanged).
  - Never throw on this path—even if static totals are missing.
- **Final record shape for MasterDB export:**
  - The synthetic item should populate description/sku/qty/price/amount/lineNo minimally so it survives `computeUsableRows` and the row builder.
  - `rows` construction expects `[HEADERS]` followed by arrays ordered as `[store, dept, number, date, salesperson, customer, address, sku, description, quantity, unitPrice, lineTotal, subtotal, discount, tax, total, paymentMethod, paymentStatus, lineNo, fileId]`. Static fields come from `invoice` and `record` context; per-row cells must conform to this order so downstream CSV/exporters remain stable.

## Future DBTEMPLATE/Header overrides for Custom Wizard
- **Where `HEADERS` is used today:**
  - Declared as a static array at module top and reused for both full `flatten` export and `flattenRows` rehydration. The first row of any MasterDB table is always `HEADERS`.
- **Which function builds column ordering:**
  - `flatten` seeds `rows` with `[HEADERS]` and appends per-item arrays in that fixed order; `flattenRows` also prepends `HEADERS` when reconstructing from stored rows, so both CSV generation paths assume the same header ordering.
- **Where `DBTEMPLATE` could be injected:**
  - The decision point is the row seeding inside `flatten`/`flattenRows`: swapping `HEADERS` for a provided template before pushing data rows would ripple through both MasterDB table generation and CSV exports.
  - `invoice-wizard.js` references `MasterDB.HEADERS` when extracting `File ID` from stored rows; it would need access to the chosen template to keep column lookups aligned.
- **Smallest change to support custom headers later:**
  - Allow `flatten`/`flattenRows` (and the exported `HEADERS` reference) to resolve to either the default static `HEADERS` or a supplied `DBTEMPLATE` when a custom wizard config is active, defaulting to `HEADERS` otherwise.
  - Keep the mapping from `invoice`/`item` fields to column positions identical, only swapping the header row source. This preserves current behavior for default wizards while enabling custom header sets when provided.
