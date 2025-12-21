# AREABOX (Highlight a Section) — Scope and Constraints

## Purpose
Single source of truth for the “AREABOX (Highlight a Section)” feature across Builder → Configuration → Run Mode → MasterDB export. All implementation work must adhere to the invariants, constraints, and acceptance criteria in this document.

## End-to-end summary
- **Builder:** Introduce AREABOX as a first-class field type alongside Static and Dynamic. Users name the Area, then add subordinate fields within the Area or regular fields outside it. Regular (non-subordinate) fields can be flagged as Global Fields to replicate values across Area-emitted rows.
- **Configuration:** Users highlight one AREABOX per Area prompt; no data extraction occurs here. The system records the AREABOX geometry plus a deep keyword scan that captures keywords nearest the top-right and bottom-left edges as Area Orientation Keywords, building an AREABOX fingerprint. Users then highlight subordinate field boxes relative to the AREABOX perimeter; geometry is stored relative to the AREABOX while maintaining document coordinates.
- **Run Mode:** Existing OCR + geometry pipeline remains intact. For wizards with Areas, an additional AREAFINDER pass runs during keyword scanning to locate Area occurrences using the stored AREABOX fingerprint and Area Orientation Keywords. For each detected Area occurrence, subordinate field extraction reuses the current bbox-first, micro-expansion logic but is constrained to the AREABOX bounds. No new extraction engines are introduced.
- **MasterDB export:** Each Area type emits its own sheet; non-subordinate fields (root-level) emit to a document-level sheet. Global Fields repeat across all Area rows for that document. Area sheets are rectangular tables with a single header row; rows align with detected Area occurrences (repeating blocks) or table rows within the Area. FILE ID is always included for joinability.

## Primary invariant
Reuse the exact same process currently used to map user-defined BBOXes and their internal data; when an Area is defined, all geometry and extraction logic is scoped to the AREABOX bounds rather than the full document.

## Coordinate invariant
All OCR tokens and all BBOX coordinates remain in **document coordinate space**. AREABOXes only restrict the candidate search region for detection and matching (same document canvas, smaller allowable search region); do **not** introduce an “area canvas.”

## Do-not constraints
- Do not change unrelated features.
- Do not refactor broadly.
- Do not introduce a new coordinate system or “area canvas.”
- Do not introduce divider-row exports or interrupted headers.
- Prefer using existing functions/logic wherever possible.

## Acceptance criteria (high-level)
- Builder shows AREABOX as a selectable type with naming, subordinate field grouping, and Global Field toggle on non-subordinate fields.
- Configuration captures one AREABOX per Area with recorded geometry and Area Orientation Keywords; subordinate fields are captured relative to the AREABOX.
- Run Mode performs an AREAFINDER pass to locate all Area occurrences via stored fingerprints, then runs existing field extraction constrained to each detected AREABOX; non-Area documents behave unchanged.
- MasterDB export produces one sheet per Area, a root sheet for non-subordinate fields (if any), Global Fields propagate across Area rows, and FILE ID is present on Area rows; tables are rectangular with single headers and no divider rows.
- Coordinates for tokens and BBOXes remain in document space throughout; AREABOX only scopes search regions.

## Glossary
- **Area / AREABOX:** A named, highlighted region that scopes subordinate field extraction; treated as a field type.
- **Subordinate Field:** A field defined inside an Area; resolved using the Area’s bounds.
- **Global Field:** A non-subordinate field whose value repeats across all Area-emitted rows for the document.
- **Area Occurrence:** One detected instance of an Area on a document during Run Mode.
- **Area Orientation Keywords:** Keywords nearest the top-right and bottom-left edges of the AREABOX captured during configuration to validate orientation and size in Run Mode.
- **AREAFINDER:** The Area detection step in Run Mode that matches stored AREABOX fingerprints to document pages.

## Likely relevant modules/files to touch (no changes made yet)
- `builder-field-row.js` — custom builder field definitions and UI toggles.
- `common-subs.js`, `master-db.js` — MasterDB row emission, static/dynamic propagation, sheet shaping.
- `ocr-magic-pipeline.js`, `ocr-magic-dev.js`, `ocrmagic-layer1.js`, `ocr-magic-pipeline.js` — OCR/geometry orchestration and keyword scanning.
- `orchestrator.js`, `trace.js`, `trace-viewer.js` — pipeline orchestration and diagnostics.
- `invoice-wizard.js`, `field-map.js` — wizard profile data structures and field metadata.
