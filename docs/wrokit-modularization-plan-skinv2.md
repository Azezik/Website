# WROKIT Modularization Plan (SkinV2 Canonical)

## Scope and guardrails
- **Canonical UX:** SkinV2 remains the canonical entrypoint and behavior baseline.
- **No big-bang rewrite:** incremental extraction only; each stage ships independently.
- **Pure-first extraction:** move deterministic helpers/scoring/geometry/constellation math before orchestration.
- **Dependency injection:** new engine entrypoints receive explicit `tokenProvider`, `profileStore`, and `rawStore` adapters.
- **Debug isolation:** Visual Run / Find Text execute with cloned state or explicit sandbox context objects.

---

## 1) Proposed folder/module map

```text
src/
  engines/
    core/
      extraction-engine.js        # orchestrates per-file/per-field extraction via injected deps
      compile-engine.js           # compileDocument equivalent, pure transform + explicit persistence boundary
      confidence-engine.js        # confidence blending + arithmetic boosts
    fields/
      static/
        static-extractor.js       # bbox-first static extraction flow
        ring-landmark.js          # ring capture/match + offset application
        static-scoring.js         # label/format/distance scoring for static fields
      columns/
        column-extractor.js       # column row assembly + wrap merge + row confidence
        column-scoring.js         # qty/unit/amount consistency checks
    findtext/
      findtext-engine.js          # search/ranking pipeline over provided tokens
      constellation-engine.js     # keyword constellation capture/match math
      ranker.js                   # candidate ranking helpers
    geometry/
      box.js                      # normalize/denormalize/intersect/expand helpers
      anchors.js                  # anchor metrics + projection helpers
      page-space.js               # viewport/page offset transforms
    cleaning/
      normalize.js                # trim/dedupe/symbol cleanup helpers
      field-normalizers.js        # money/date/id/name/address field-level normalization

  adapters/
    skinv2/
      ui-controller.js            # tab orchestration + event wiring to engines
      token-provider.js           # PDF.js + OCR token retrieval implementation
      profile-store.js            # local/cloud profile persistence implementation
      raw-store.js                # extracted raw field persistence implementation
    legacy/
      legacy-ui-controller.js     # legacy shell wiring to same engines
      token-provider.js
      profile-store.js
      raw-store.js
    debug/
      visual-run-adapter.js       # visual run wrapper around engines with sandbox context
      find-text-adapter.js        # find text wrapper around engines with sandbox context

  debug/
    sandbox/
      context-factory.js          # cloned state/context builder
      sandbox-store.js            # isolated in-memory stores for debug benches
      parity-recorder.js          # captures run parity metrics per stage

  contracts/
    engine-contracts.js           # typedef/interfaces for tokenProvider/profileStore/rawStore
    result-schemas.js             # extracted field/run/compile result schemas

  migration/
    profile-v3-compat.js          # existing version migration helpers extracted behind API
```

### Notes on current mapping
- Existing utility files (`tools/*`, `orchestrator.js`, `field-map.js`, `snapshot-store.js`) become source candidates for `engines/*` and `contracts/*` once wrapped in explicit dependencies.
- Existing `invoice-wizard.js` remains as the shell orchestrator during migration; logic is peeled out stage-by-stage.

---

## 2) Staged extraction plan (small, verifiable steps)

## Stage 1 — Contracts + adapter seams (no logic move yet)
**Move**
- Add `contracts/engine-contracts.js` defining interfaces for:
  - `tokenProvider` (`getPageTokens`, `getPageViewport`, `ensureDocumentLoaded`)
  - `profileStore` (`loadProfile`, `saveProfile`, `migrateProfile`)
  - `rawStore` (`upsert`, `getByFile`, `clearByFile`)

**Stay**
- All extraction logic remains in current files.

**Verify**
- Shell still uses current behavior but now calls through thin adapter wrappers.
- No UX changes in SkinV2 tab flows.

**Parity checks**
- Token counts per page match baseline (`pdf` + `tess` modes).
- Active `geometryId` and `wizardId` selected for run match baseline.
- Extracted field count per file unchanged.
- Compiled row count unchanged for same input batch.

---

## Stage 2 — Extract pure geometry + normalization helpers
**Move**
- Move stateless helpers into `engines/geometry/*` and `engines/cleaning/*`:
  - box normalize/expand/intersect; page-space transforms
  - whitespace cleanup, duplicate phrase collapse, trailing symbol trimming

**Stay**
- `extractFieldValue` orchestration remains in place; function calls redirected to imported helpers.

**Verify**
- Unit tests around helper equivalence (input/output snapshots).

**Parity checks**
- Per-field selected bbox (px + normalized) equality.
- Per-field cleaned value string equality.
- No change to field confidence ordering for same candidates.

---

## Stage 3 — Extract Find Text + constellation math into pure engines
**Move**
- Move ranking and constellation computation into:
  - `engines/findtext/findtext-engine.js`
  - `engines/findtext/constellation-engine.js`
  - `engines/findtext/ranker.js`

**Stay**
- UI bindings/events stay in current shell.

**Verify**
- Debug tab outputs for Find Text are byte-for-byte comparable in candidate lists where deterministic.

**Parity checks**
- Candidate count + top candidate id per query/source (PDF.js/Tesseract).
- Matched page number + bbox for best result.
- Constellation box count and anchor/support token ids unchanged.

---

## Stage 4 — Extract static field scoring and bbox-first candidate selection
**Move**
- Static scoring components to `engines/fields/static/static-scoring.js`.
- Keep orchestration but delegate candidate ranking/cleanup to module.

**Stay**
- Token acquisition, run loops, and profile writes remain in current shell.

**Verify**
- Static field outputs remain parity for baseline profiles/docs.

**Parity checks**
- Extracted static field count per run unchanged.
- Per-field value equality (or exact fallback tie-break behavior).
- Confidence delta threshold (e.g., abs diff ≤ 0.01 unless expected by deterministic tie updates).

---

## Stage 5 — Extract ring landmark + anchor projection module
**Move**
- Ring/anchor logic into:
  - `engines/fields/static/ring-landmark.js`
  - `engines/geometry/anchors.js`

**Stay**
- Field loop orchestration in shell.

**Verify**
- Landmark hit/miss decisions and resolved value boxes stay equivalent.

**Parity checks**
- Ring match score per static field (within epsilon).
- Applied offset/resolved bbox equality.
- Geometry context (`wizardId`, `geometryId`) preserved through run.

---

## Stage 6 — Extract column extractor module
**Move**
- Column logic into:
  - `engines/fields/columns/column-extractor.js`
  - `engines/fields/columns/column-scoring.js`

**Stay**
- Compile flow still in shell.

**Verify**
- Line items table remains equivalent for baseline docs.

**Parity checks**
- Row count and row order unchanged.
- Qty/unit/amount parse success rates unchanged.
- Wrapped description merge counts unchanged.

---

## Stage 7 — Extract compile engine and persistence boundary
**Move**
- `compileDocument` transformation into `engines/core/compile-engine.js`.
- Persistence side-effects behind injected `rawStore`/db adapter.

**Stay**
- UI rendering calls (`renderResultsTable`, `renderReports`) remain in shell.

**Verify**
- Compiled output schema and row payload parity.

**Parity checks**
- Compiled record count unchanged.
- Field keys present/absent unchanged.
- Master DB row count and primary identifiers unchanged.

---

## Stage 8 — Introduce unified extraction-engine orchestrator
**Move**
- New `engines/core/extraction-engine.js` orchestrates per-file run using injected adapters and extracted modules.

**Stay**
- SkinV2 shell invokes engine through adapter but preserves same tab lifecycle and notifications.

**Verify**
- Batch and single-file runs in SkinV2 produce same outputs as baseline.

**Parity checks**
- Token counts per processed page.
- Extracted fields count + non-empty fields count.
- `wizardId`/`geometryId` context continuity through run start→finalize.
- Compile rows count per file and per batch.

---

## Stage 9 — Sandbox debug benches (Visual Run + Find Text)
**Move**
- Debug wrappers into `adapters/debug/*` using `debug/sandbox/context-factory.js`.
- Bench flows call shared engines with cloned/sandboxed context.

**Stay**
- Existing debug UI remains until parity is proven.

**Verify**
- Debug actions no longer mutate primary run state except explicit, whitelisted outputs.

**Parity checks**
- Main run context (`state.activeWizardId`, `state.activeGeometryId`, `state.steps`) unchanged after debug sessions.
- Same token counts and extraction result for debug invocation vs prior behavior.
- No unintended writes in primary `rawStore`/profileStore during sandbox runs.

---

## Stage 10 — Legacy adapter switch to engine-only calls
**Move**
- Legacy shell uses `adapters/legacy/*` to call same `engines/*` entrypoints.

**Stay**
- Legacy UI remains compatibility shell; no new capabilities required.

**Verify**
- Legacy extraction outputs stay compatible while sharing canonical engine path.

**Parity checks**
- Legacy run extracted field count unchanged.
- Legacy-selected model/wizard context maps to same `wizardId` + `geometryId`.
- Compile rows and export payload counts unchanged.

---

## 3) Stage parity checklist template (apply to every stage)

For each stage rollout, record before/after metrics for a fixed baseline corpus:

1. **Token metrics**
   - `pdfTokenCountByPage`
   - `tessTokenCountByPage`
2. **Extraction metrics**
   - `staticFieldsConfigured`
   - `staticFieldsExtractedNonEmpty`
   - `columnRowsExtracted`
3. **Context metrics**
   - `username`, `docType`
   - `wizardId`, `geometryId`
   - selected model context source (`custom/model/default`)
4. **Compile metrics**
   - `compiledRecordCount`
   - `fieldKeyCountPerRecord`
   - `masterDbRowCount`
5. **Diff policy**
   - hard fail: context mismatch (`wizardId`/`geometryId`), missing record, row count regressions
   - soft review: confidence numeric drift within epsilon, tie-break shifts with identical value

---

## Verification order (recommended)
1. Run fixed baseline docs in SkinV2 before each stage.
2. Apply stage extraction.
3. Re-run same corpus and generate parity report.
4. If parity passes, proceed; if not, rollback that stage only.

This keeps SkinV2 behavior stable while progressively converting Legacy and debug benches into thin clients of a shared canonical engine.
