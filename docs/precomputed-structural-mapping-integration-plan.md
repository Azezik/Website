# Precomputed Structural Mapping Integration Plan

## Current WrokitVision Role in the Pipeline

WrokitVision is currently an **engine option** (`engineType: wrokit_vision`) selected through `EngineRegistry` and invoked from the same extraction flow used by other engines. It is responsible for:

- Producing engine-owned field configuration (`wrokitVisionConfig`) at wizard selection time via `registerField`.
- Running static scalar extraction at runtime via `extractScalar`.
- Building/caching a text + structural map bundle used both by runtime extraction and debug UI overlays.
- Creating geometry-level seed artifacts (`seedStructuralGraph`, `seedTextGraphSummary`) during configuration.

Despite that, orchestration still lives in the monolithic `invoice-wizard.js` flow, so WrokitVision plugs in as a **specialized static-field extractor and config artifact producer**, not as a standalone end-to-end runtime.

## Existing Inputs and Outputs

### Inputs WrokitVision receives today

1. **Configuration-time registration input** (`registerField` payload):
   - Step metadata (`fieldKey`, type, etc.)
   - Normalized box + raw pixel box
   - Page number + viewport
   - Per-page OCR tokens
   - Optional image grayscale payload for visual region context
   - Current profile + geometryId

2. **Runtime extraction input** (`extractScalar` payload):
   - `fieldSpec` (includes saved `wrokitVisionConfig`)
   - OCR tokens for the page
   - Candidate bbox in px (`boxPx`)
   - viewport
   - optional prebuilt `runtimeMaps`
   - profile + geometryId

3. **Upload/config-time seed creation input** (`createSeedArtifacts`):
   - tokens + viewport only (current implementation)

### Outputs and artifacts WrokitVision produces today

1. **Per-field persisted engine config** (`field.wrokitVisionConfig`) including:
   - bbox metadata, label hints, page/viewport/rawBox
   - neighborhood payload (`textNeighbors`, `structuralNeighbors`, optional `visualRegionContext`)
   - map stats

2. **Runtime scalar extraction result** contract consumed by caller:
   - `value`, `raw`, `confidence`, `boxPx`, `tokens`, `method`, `engine`
   - optional metadata (`geometryId`, `correctionsApplied`, `lowConfidence`)

3. **Geometry-level profile artifacts** (`profile.wrokitVision.geometryArtifacts[geometryId]`):
   - `seedStructuralGraph`
   - `seedTextGraphSummary`
   - generated timestamps/version markers

4. **Runtime/debug map artifact** (non-persisted runtime cache):
   - `{ textMap, structuralGraph }`

### Downstream expectations in current pipeline

- `extractFieldValue` expects a synchronous scalar engine result and remaps it into raw-store entries.
- `compileRecord` expects scalar records with values/confidence/tokens and remains engine-agnostic.
- UI/debug overlays expect `WrokitVisionEngine.buildMaps(...)` output shape and graph visibility controls.
- Profile migration/versioning expects `profile.wrokitVision.*` to exist and be backward-safe.

## Current Relevant Modules and Responsibilities

- `engines/core/wrokit-vision-engine.js`
  - Engine façade (`registerField`, `extractScalar`, `buildMaps`, `createSeedArtifacts`)
  - Current bbox-first micro-expansion extraction logic
  - Cleaning/normalization for numeric/date fields

- `engines/core/wrokit-vision-maps.js`
  - Text topology-lite map construction
  - Structural graph creation (token-driven + optional pixel-driven region layer)
  - Neighborhood capture and visual region lookup

- `engines/core/engine-registry.js`
  - Selects engine adapters for config registration and runtime scalar extraction

- `invoice-wizard.js`
  - Calls WrokitVision registration/extraction
  - Manages profile migration defaults and seed graph creation trigger
  - Maintains runtime map/debug caches

- `engines/core/compile-engine.js`
  - Downstream consumer of extracted scalar records (engine-neutral contract)

## Reusable Components

1. **Engine boundary and dispatch wiring**
   - Keep `EngineRegistry` integration points (`registerFieldConfig`, `extractScalar`) so wider pipeline remains unchanged.

2. **Profile-level artifact locations**
   - Existing `profile.wrokitVision.geometryArtifacts` is the natural persistence location for upload-time structural precompute artifacts.

3. **Existing bbox-first extraction policy primitives**
   - `tokensInBox`, line grouping, micro-expansion loop scaffolding are directly aligned with current AGENTS policy and can be retained as a fallback strategy.

4. **Field cleaning and type-aware normalization helpers**
   - Numeric/date cleanup utilities can remain a post-resolution cleanup stage.

5. **Debug map UX hooks**
   - Existing debug cache/render triggers in `invoice-wizard.js` can continue to consume new map artifacts through adapters.

6. **Column and scoring helper modules outside WrokitVision core**
   - `engines/fields/columns/*` and `engines/fields/static/static-scoring.js` provide reusable deterministic scoring/comparison utilities for the matching stage.

## Replace / Refactor Candidates

1. **Current `buildTextMap`/`buildStructuralGraph` schema (v1/v3 ad hoc graph)**
   - Replace with typed node/edge contracts from the new spec (`StructuralRegionNode`, `TextTokenNode`, typed edges, provenance/rationale).

2. **Current runtime-only map generation coupling**
   - Refactor away from rebuilding maps opportunistically during extraction; introduce a first-class upload-time precompute artifact service and retrieval path.

3. **`registerField` payload shape as final signature**
   - Replace neighborhood-only capture with explicit `SelectionSeed` + `LocalSubgraph` + `FieldSignature` generation.

4. **Single-pass candidate line ranking in `extractScalar`**
   - Refactor into selection resolver + local relevance scorer + signature matcher modules.

5. **Seed artifact generator (`createSeedArtifacts`)**
   - Replace with full structural precompute orchestrator producing all required families (regions, text topology, surfaces, adjacency).

6. **Implicit confidence computation**
   - Replace with inspectable `ScoreBreakdown` objects and persisted rationale traces.

## Proposed New Module Layout

Suggested internal package split under WrokitVision (names illustrative, contracts stable):

1. `engines/wrokitvision/precompute/`
   - `precompute-orchestrator.js`
   - `region-proposals.js`
   - `text-topology.js`
   - `surface-candidates.js`
   - `typed-graph-builder.js`
   - Output: `PrecomputedStructuralMap` artifact (versioned)

2. `engines/wrokitvision/selection/`
   - `selection-seed-resolver.js`
   - `local-relevance-scorer.js`
   - `local-subgraph-reconstructor.js`
   - `local-frame-estimator.js`
   - Output: `SelectionResolutionResult`

3. `engines/wrokitvision/signature/`
   - `field-signature-builder.js`
   - `field-signature-validator.js`
   - `field-signature-store-adapter.js`
   - Output: versioned `FieldSignature`

4. `engines/wrokitvision/matching/`
   - `signature-matcher.js`
   - `candidate-ranker.js`
   - `match-confidence.js`
   - Output: extracted value + confidence + `ScoreBreakdown`

5. `engines/wrokitvision/debug/`
   - `overlay-render-model.js`
   - `trace-bundle-builder.js`

6. `engines/wrokitvision/compat/`
   - `legacy-map-adapter.js` (new typed graph -> old debug shape)
   - `legacy-extract-adapter.js` (new matching result -> current `extractScalar` return contract)

7. `engines/core/wrokit-vision-engine.js` (façade retained)
   - Becomes orchestration façade only, delegating to precompute/selection/signature/matching modules.

## External Contracts That Must Still Be Satisfied

1. **Engine registry contract**
   - `registerFieldConfig(engineType, payload)` must still return `{ wrokitVisionConfig: ... }`.
   - `extractScalar(engineType, payload)` must still return scalar extraction payload consumed by `extractFieldValue`.

2. **Profile schema compatibility**
   - Continue storing data under `profile.wrokitVision` with `geometryArtifacts` and `runtimePolicies` support.
   - Existing profiles that only have minimal/null `wrokitVisionConfig` must still run.

3. **Raw entry and compile contract**
   - Final downstream entries still need `value/raw/confidence/tokens/correctionsApplied/engineUsed` fields to keep compile + MasterDB flow unchanged.

4. **UI debug expectations**
   - Existing graph debug UI must not break; provide adapter output until UI migrates to fully typed-graph overlays.

5. **Deterministic bounded extraction behavior**
   - BBox-first and local micro-expansion constraints remain mandatory during resolution/matching.

## Integration Strategy

1. **Introduce precompute artifact lifecycle at upload/token-ready stage**
   - On page token readiness (and optional image data), build + cache + optionally persist `PrecomputedStructuralMap` keyed by document page + geometry context.
   - Reuse same artifact in config mode and run mode.

2. **Selection-time resolution in wizard confirm flow**
   - Replace direct neighborhood capture in `registerField` with:
     - seed association from selection bbox
     - bounded local relevance scoring
     - local frame computation
     - field signature creation
   - Persist signature in `field.wrokitVisionConfig` (or nested `fieldSignature`) with version tag.

3. **Future extraction path uses signature matcher**
   - At runtime, fetch precomputed map for the page.
   - Use stored field signature to resolve candidate local neighborhood and output value.
   - Keep existing post-cleaning/normalization and downstream write path.

4. **Bridge old/new debug models**
   - Build adapter that converts typed graph and score traces into current debug panes while a richer debug UI is added later.

5. **Keep legacy path feature-flagged during rollout**
   - Add runtime policy toggle per profile/geometry to switch between legacy extraction and structural-mapping matcher.

## Migration / Compatibility Strategy

1. **Versioned artifact + signature envelopes**
   - Add explicit `wrokitVision.version` and per-field `signatureVersion`.
   - Support loading v3/v10/v11-era profiles with missing artifacts by lazy-generation.

2. **Lazy backfill on read**
   - If profile lacks precomputed artifacts/signatures:
     - keep current extraction behavior
     - optionally backfill artifacts in background when document is opened in config mode.

3. **Dual-read / single-write transition**
   - During transition:
     - read both legacy `neighborhoods` and new `fieldSignature`
     - prefer new signature when available
     - write new signature format; keep minimal legacy fields for rollback.

4. **Compatibility adapters**
   - `legacy-extract-adapter` ensures caller still receives current scalar result shape.
   - `legacy-map-adapter` keeps debug graph views functional.

5. **Migration safety checkpoints**
   - Golden tests comparing old/new outputs for representative templates.
   - Confidence regression tracking and low-confidence review rates before default switch.

## Recommended Implementation Phases

1. **Phase 1 — Contract groundwork**
   - Define typed graph entities/edges + serializer/versioning.
   - Add compatibility adapters and fixture tests.

2. **Phase 2 — Upload-time precompute layer**
   - Implement and persist `PrecomputedStructuralMap` with all required output families.
   - Wire into upload/page-token lifecycle and runtime cache.

3. **Phase 3 — Selection-time local resolution + signature creation**
   - Implement seed association, local relevance, local frame, signature builder.
   - Update `registerField` path to persist signatures.

4. **Phase 4 — Runtime signature matching extraction**
   - Implement matcher and replace current line-only scoring for WrokitVision static fields.
   - Preserve bbox-first/micro-expansion policy and non-rejection fallback.

5. **Phase 5 — Debug/inspection hardening**
   - Add score breakdown traces and overlay layers for all three stages.
   - Verify inspectability requirements from spec.

6. **Phase 6 — Controlled migration and default cutover**
   - Enable per-profile/geometry flag rollout.
   - Run A/B + regression suite.
   - Remove dead legacy internals after parity thresholds are met.
