# AREABOX vs. current implementation

## Purpose of this review
The original "Highlight a Section" design called for three pillars: a builder surface that introduces an Areabox field with subordinate fields and global field replication, a configuration flow that fingerprints keywords and geometry relative to the area box, and a run-mode detector that reuses the stored fingerprint to locate every matching area so subordinate fields can be extracted inside its bounds. This note compares that intent with what is currently implemented in the codebase.

## What the code currently does
- **Builder/UI**
  - The custom field row component exposes an `Areabox` type alongside Static and Dynamic, changes the placeholder to "Area name," and disables the Global Field toggle on areas or subordinate rows. 【F:builder-field-row.js†L21-L114】
  - Wizard question ordering injects each area prompt followed immediately by its subordinate fields, ensuring the configuration flow asks the area first. 【F:invoice-wizard.js†L3212-L3253】

- **Configuration capture**
  - When a user draws an Area box, the system stores the normalized and pixel geometry plus a fingerprint that records every token inside the area with center-relative offsets, edge distances, and the nearest tokens to the top-right and bottom-left corners flagged as orientation anchors. 【F:invoice-wizard.js†L1155-L1245】
  - Subordinate field boxes are saved relative to the area box via `computeAreaRelativeBox`, so later runs can convert them back to absolute coordinates inside each detected area. 【F:invoice-wizard.js†L1142-L1153】【F:invoice-wizard.js†L7048-L7066】

- **Run-mode area detection**
  - During keyword indexing, `AreaFinder.findAreaOccurrencesForPage` is called for areas on the current page and, if no matches are found for an area, a low-confidence fallback recreates the originally drawn box. 【F:invoice-wizard.js†L6834-L6986】
  - `AreaFinder` seeds detection from exact text matches to the two orientation tokens and reconstructs an area box from their stored edge offsets. Size is validated loosely (≥60% of expected width/height), `relError` is stubbed to zero, and other stored keywords/neighbor distances are unused. 【F:tools/areafinder.js†L16-L154】

- **Scoped extraction & export**
  - For each detected (or fallback) area occurrence, subordinate fields are re-extracted using only tokens inside the area bounds; relative boxes are converted back to absolute coordinates before extraction. 【F:invoice-wizard.js†L6990-L7074】
  - MasterDB builds a separate sheet per area, merges in any configured Global Fields for every row, and keeps FILE ID as the final column for joinability. 【F:master-db.js†L681-L724】

## Gaps versus the design intent
- **Fingerprint richness not used in matching.** The fingerprint captures full keyword layouts and neighbor relationships, but run-mode detection only uses the two corner tokens and a coarse size check, with `relError` returning zero and no verification of the internal distances or edge alignment the design calls for (e.g., purple/blue relation lines in the doc). 【F:invoice-wizard.js†L1155-L1245】【F:tools/areafinder.js†L16-L154】
- **No geometric validation against area perimeter.** Orientation edge offsets are used solely to expand from a token to a candidate box; the detector does not re-check that tokens lie at consistent distances from the area edges or from each other, so sliding the same keywords elsewhere on the page would still pass, contrary to the strict perimeter-relative matching envisioned. 【F:tools/areafinder.js†L16-L154】
- **Single-page expectation.** Areas are only searched on the page recorded in the fingerprint (`areaFingerprint.page`), so repeating sections on other pages are skipped instead of being discovered wherever the fingerprint matches. 【F:invoice-wizard.js†L6834-L6986】
- **Fallback hides detection failure.** If no orientation tokens are found, the code silently reuses the originally drawn box with 0.01 confidence, which masks missed matches rather than surfacing a failure to find a fingerprinted area. 【F:invoice-wizard.js†L6854-L7074】
- **Orientation tokens are not keyword-scoped.** Any token text inside the area can become an orientation anchor; there is no bias toward true keywords near the edges as described in the original doc, increasing the risk that data values or noise anchor the fingerprint. 【F:invoice-wizard.js†L1155-L1245】

## Consequences
These gaps mean the system does not yet deliver the intended "move the fingerprint anywhere and realign the orange boxes" behavior. Matching tolerates large drift, ignores internal layout geometry, and silently falls back to the saved rectangle, so repeated areas or shifted sections may be missed or misaligned without clear signals to users.
