# MasterDB Dynamic-to-Static Enrichment Research

## Context
- MasterDB output rows are produced by `MasterDB.flatten(record)`, which normalizes invoice header fields (store, department, dates, totals, payment method/status) from `record.fields` and merges them with each dynamic line item before generating CSV rows.【F:master-db.js†L57-L72】【F:master-db.js†L490-L523】
- Line items are cleaned and annotated (synthetic zero rows, missing flags, inferred totals, synthetic line numbers) before MasterDB row synthesis; empty header fields remain blank because `buildInvoiceCells` only reads `record.fields` without consulting dynamic content.【F:master-db.js†L75-L139】【F:master-db.js†L340-L488】
- During extraction, `compileDocument` assembles a `compiled` record with `fields` (static/dynamic scalars) from the in-memory `rawStore`, and `lineItems` from the dynamic column extractor; the compiled record is saved to local storage and immediately piped into MasterDB row regeneration via `refreshMasterDbRowsStore`.【F:invoice-wizard.js†L6572-L6663】【F:invoice-wizard.js†L520-L569】
- The dynamic column extractor builds each `lineItems` entry with cleaned values plus a `__missing` map and other metadata that survive into `lineItems` and are available for any enrichment logic run before MasterDB flattens the record.【F:invoice-wizard.js†L5093-L5205】

## Key Questions from the Request
1. **Where is Department/Division right before MasterDB generation?**
   - It is read from `record.fields.department_division` (or `record.fields["department_division"].value`) inside `buildInvoiceCells` just before rows are built.【F:master-db.js†L57-L72】 If this field is empty, MasterDB emits a blank cell and continues.
2. **How to populate header fields (Department/Division, Payment Method, addresses, etc.) when the user skipped the static questions but the values exist in dynamic content (SSOT)?**
   - Introduce a preprocessing step that inspects `compiled.lineItems` (and their `__missing` metadata) to propose fallback values for specific header fields when the corresponding `record.fields[...]` entries are blank. This can run immediately after `compileDocument` builds `compiled` and before `refreshMasterDbRowsStore`/`MasterDB.flatten` consume it.

## Feasible Implementation Path
### 1) Add an "enrichment" pass before MasterDB flattening
- **Hook point:** After `compileDocument` constructs `compiled` but before it is stored and MasterDB rows are refreshed.【F:invoice-wizard.js†L6623-L6660】 Alternatively, wrap `buildMasterDbRowsFromRecord` to normalize records before calling `MasterDB.flatten` so historical runs also benefit.【F:invoice-wizard.js†L520-L569】
- **API sketch:** `const enriched = enrichRecordWithDynamicFallbacks(compiled);` where the function can:
  - Read `compiled.fields` and `compiled.lineItems` (plus optional `compiled.totals`).
  - Fill missing scalars (e.g., `department_division`, `payment_method`, `customer_name`, `customer_address`) only when the field is blank and confidence is low/zero, preserving existing values.
  - Record provenance (e.g., `fields[fieldKey].fromDynamic = true` or append to `correctionsApplied`) for UI transparency.

### 2) Candidate signals for Department/Division fallback
- **Row text mining:** Use line-item `description` or custom dynamic columns to extract department labels. Since each row retains `__cells` metadata per column, heuristics can prefer values from the column designated as “department” (if present) or search for patterns like `[A-Z]{2,4}` codes at the start of descriptions.【F:invoice-wizard.js†L5093-L5184】
- **Row selection policy:** Reuse MasterDB’s majority logic by prioritizing rows whose dynamic columns are well-populated (`__columnHits`/`__totalTokens`) or those that contributed to the majority row count. This keeps fallback deterministic and aligned with rows MasterDB keeps.【F:master-db.js†L340-L418】
- **Confidence handling:** Set a conservative default (e.g., 0.5) for enriched fields so downstream UI can surface ⚠️ warnings similar to low-confidence static captures.

### 3) Payment Method and Payment Status from dynamic traces
- If static `payment_method`/`payment_status` are blank, scan dynamic text tokens on the page for known payment phrases ("cash", "credit", "ACH", "wire"). The OCR tokens already flow through `rawStore` per field; to avoid page-wide rescans, allow the enrichment pass to peek at `compiled.raw` tokens for related questions or add a lightweight keyword search over the same pages used by line items.
- Persist inferred values into `compiled.fields.payment_method.value` / `.payment_status.value` only when empty, again tagging provenance.

### 4) Customer info (name/address) from dynamic rows
- Some templates emit customer info in the dynamic table (e.g., first row description). Since MasterDB currently ignores dynamic-only runs, the enrichment pass can:
  - Check the first non-empty `description` or a dedicated custom column for patterns that look like company names or street addresses (numbers + street suffix), using the same cleaning helpers as MasterDB (`cleanText`).【F:master-db.js†L28-L72】
  - Populate `customer_name` and `customer_address` when the static fields are blank and the parsed strings pass minimal validation (length, presence of digits for address).

### 5) Respecting existing integrity and diagnostics
- **Missing-map continuity:** Preserve the `missingMap` behavior by marking enriched fields with a distinct flag so audits can separate user-provided vs inferred data.
- **No changes to line-item majority pruning:** Keep MasterDB’s current majority-row selection intact to avoid reintroducing noisy rows when deriving fallbacks.【F:master-db.js†L340-L418】
- **Idempotence:** Ensure running enrichment multiple times doesn’t keep overriding user edits; only act when the target field is blank or explicitly flagged missing.

## Workstream Outline
1. **Design enrichment function:** Define the contract (inputs/outputs, provenance tags, confidence defaults) and place it either in `invoice-wizard.js` near `compileDocument` or as a utility consumed by `buildMasterDbRowsFromRecord` so both new and cached runs are covered.
2. **Implement heuristic detectors:**
   - Department from line-item descriptions / custom columns.
   - Payment method/status keyword matcher.
   - Customer name/address patterns.
3. **Wire into MasterDB pipeline:** Invoke enrichment before calling `MasterDB.flatten` and log when fallbacks were applied, mirroring current integrity logging for transparency.【F:master-db.js†L409-L488】
4. **Add tests:** Extend `test/master-db.test.js` with cases where static fields are empty but dynamic rows contain the values; assert that enrichment populates the header columns while maintaining existing row counts and missing-map behavior.

## Risks & Mitigations
- **False positives from noisy descriptions:** Mitigate by requiring minimal token quality (presence of letters, absence of total/tax keywords) and by limiting to majority-selected rows.
- **User overrides:** Keep manual edits in the results table respected by not overwriting non-empty `fields` entries and by persisting a `fromDynamic` flag to inform the UI.
- **Performance:** Enrichment works on in-memory arrays already available at compile time; no additional PDF parsing is required, so impact should be negligible compared to OCR/column extraction.
