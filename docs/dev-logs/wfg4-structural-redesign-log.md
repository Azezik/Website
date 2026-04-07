# WFG4 Structural Redesign — Dev Log

Branch: `claude/wfg4-structural-redesign-jQSIV`
Source spec: `docs/wfg4-structural-redesign.md`

## Architectural summary

Move WFG4 from neighborhood ORB + template refine toward a three-level
structure-led pipeline:

1. Page structure (regions, row bands, separators, structural objects)
2. Constellation-level structural frame (3–6 stable, distributed objects)
3. Field-level reconstruction (normalized geometry inside constellation)

Local ORB/template refine is demoted to a final precision-only step.
The existing per-field localization contract is preserved and *augmented*
with structural metadata — no competing model is introduced.

## Phased implementation plan

### Phase 1 — Structural prepass data model

- **Goal:** Promote structural detections to first-class, reusable data
  structures shared by config and runtime.
- **Scope (in):** Define `PageStructure` containing regions/containers,
  row bands, separators, and generic structural objects with normalized
  geometry; wrap existing detectors behind a single `build_page_structure()`
  entrypoint; serialize to JSON.
- **Scope (out):** No matching logic, no config schema changes yet.
- **Code areas:** WFG4 structural detection modules and overlay producers.
- **Data model:** New `PageStructure`, `StructuralObject`, `RowBand`,
  `Separator`, `Region` dataclasses (normalized 0..1 page coords).
- **Runtime:** No behavior change; prepass runs and is exposed via debug.
- **Done when:** Both config and run paths produce identical-shape
  `PageStructure`; overlay can render from it; round-trips through JSON.

### Phase 2 — Constellation construction at config time

- **Goal:** For each user-drawn field bbox, build and persist a
  constellation-level structural frame.
- **Scope (in):** Constellation builder (sector/coverage-aware selection of
  3–6 distributed structural objects), owning region selection, internal
  row/separator capture, object↔object relationships (normalized distance,
  alignment, containment, ordering). Augment the existing field config
  record with a `constellation` block. *Decision:* selection uses an
  8-sector coverage scorer with stability weighting; justification — gives
  spatial distribution without requiring full graph optimization.
- **Scope (out):** Runtime matching; field-level relationships (Phase 3).
- **Code areas:** Config-time WFG4 capture path; field config serializer.
- **Data model:** Add `field.constellation = { id, owning_region,
  region_geom_norm, members[], relations[] }` alongside existing fields.
- **Runtime:** None.
- **Done when:** Saving a config produces a constellation per field;
  re-loading config preserves it; debug overlay shows the chosen members.

### Phase 3 — Field-level structural identity at config time

- **Goal:** Store field geometry relative to its constellation, plus
  field-level mini-constellation.
- **Scope (in):** Compute `bbox_rel_constellation` (cx, cy, w, h ratios),
  `bbox_rel_row`, distances/overlaps to nearby objects, nearest separator,
  adjacent rows, slot/value band linkage, object↔bbox relations.
- **Scope (out):** Runtime reconstruction.
- **Code areas:** Config-time field record builder; serializer.
- **Data model:** Add `field.structural_identity { ... }`; existing pixel
  bbox remains the authoritative base representation.
- **Runtime:** None.
- **Done when:** Each saved field carries normalized structural identity
  alongside its legacy geometry; backwards-compatible loaders accept both
  old and new records.

### Phase 4 — Runtime candidate constellation selection

- **Goal:** At run time, build the same `PageStructure` and shortlist
  candidate constellations matching the saved one.
- **Scope (in):** Runtime prepass reuse; coarse matcher producing top-K
  candidate frames from saved constellation identity (region geometry,
  member object types, coarse arrangement).
- **Scope (out):** Fine match scoring (Phase 5).
- **Code areas:** New `wfg4/structural/candidate_select.py` (or local
  equivalent); runtime entrypoint hook before existing ORB stage.
- **Data model:** None persisted; in-memory `CandidateConstellation`.
- **Runtime:** Adds prepass + shortlist; ORB path still runs as fallback.
- **Done when:** Runtime returns ≥1 candidate for typical pages; debug
  exposes shortlist with scores.

### Phase 5 — Constellation-level structural matching

- **Goal:** Score candidates using object↔object relationships and
  partial-match tolerance; pick the best frame(s).
- **Scope (in):** Relation-graph scorer, partial-match handling, support
  for repeated constellations (return N matches when above threshold).
- **Scope (out):** Field reconstruction.
- **Code areas:** Structural matcher module; runtime orchestrator.
- **Data model:** None.
- **Runtime:** Selected constellation(s) feed Phase 6; ORB still gated as
  refine-only fallback behind a flag.
- **Done when:** Matcher emits scored selections with member-correspondence
  map; partial matches accepted; debug shows score breakdown.

### Phase 6 — Field reconstruction + hierarchical transforms

- **Goal:** Reconstruct the field bbox from matched constellation using
  hierarchical (page → constellation → field) normalized projection;
  fall back to normalized priors on partial matches.
- **Scope (in):** Transform estimator (similarity / affine as minimum
  stable model — *decision:* start with similarity to keep robustness;
  upgrade to affine only when ≥4 well-distributed correspondences exist),
  field projector, slot/row snapping, prior-fallback path.
- **Scope (out):** Visual refine.
- **Code areas:** New `field_reconstruct.py`; runtime orchestrator wires
  reconstructed bbox into the existing localization contract.
- **Data model:** Existing field localization contract receives the
  reconstructed bbox; structural metadata attached as auxiliary fields.
- **Runtime:** Structural reconstruction becomes the primary localizer.
- **Done when:** Reconstructed bbox is produced for matched fields and
  passed to downstream readout via the existing contract.

### Phase 7 — Refine demotion, diagnostics, and repeated-match policy

- **Goal:** Restrict ORB/template to post-structural precision refine,
  add full diagnostics, and expose repeated-match output policy.
- **Scope (in):** Gate ORB/template behind reconstructed bbox; small
  positional correction only; debug surface for page objects, candidates,
  scores, selected constellation, field-level constellation, pre/post
  refine bboxes; search-policy switch for single vs multi-instance output.
- **Scope (out):** Any redesign of PDF/token/OCR contracts.
- **Code areas:** Runtime orchestrator, debug/overlay, search policy.
- **Data model:** None.
- **Runtime:** ORB/template no longer determines field identity; multi-
  match emission available via policy.
- **Done when:** End-to-end run uses structural pipeline with refine as
  precision-only; diagnostics complete; multi-instance switch tested.

## Phase 1 — Implementation record (2026-04-07)

### What was done

**`engines/wfg4/wfg4-opencv.js`**
- Added `buildPageStructure(grayMat, surfaceSize, opts)` (≈110 lines).
- Calls existing `detectEdgesAndLines()` and `detectContainers()` internally
  — no new CV operations introduced, just promotion to a structured return.
- Builds `regions[]` (normalized containers), `rowBands[]` (horizontal line
  clusters, gap ≤ max(10px, 2% page height)), and `structuralObjects[]`
  (unified list for Phase 2+ constellation use).
- Row bands with x-span ≥ 25% of page width are tagged `isSeparator: true`.
- All geometry stored in both pixel (`Px`) and normalized (`N`, 0..1) forms.
- Exported via the module return object.

**`engines/core/wfg4-engine.js`**
- In `normalizePage()`: declared `pageStructure = null` alongside
  `globalScan`, then called `CvOps.buildPageStructure(gray, ...)` using the
  same gray mat already created for `globalScan` — no extra CV allocation.
- `pageStructure` added to the returned page entry object.
- Both config-time and runtime surfaces flow through `normalizePage()`, so
  a single code path produces identical-shape `PageStructure` for both.

**`engines/wfg4/wfg4-registration.js`**
- Added `pageStructure: pageEntry?.pageStructure || null` to the config
  packet immediately after `phase3Ready: true`.
- No new computation — reads the value already placed on `pageEntry` by
  `normalizePage()`.

### Design decisions made during implementation

- Row-band gap threshold: `max(10px, 2% of page height)` — small enough to
  separate adjacent form rows, large enough to cluster noisy duplicates.
- Separator span threshold: 0.25 (25% of page width) — configurable via
  `opts.separatorSpanThreshold` if needed.
- `buildPageStructure` re-uses the two existing detector calls rather than
  running a third pass; raw line/container data from `globalScan` is not
  cached between the two because `globalScan` only stores aggregate counts,
  not the raw arrays. The extra detector cost is negligible (same gray mat).

### Fixes / deviations

- None. Phase 1 is additive only. All existing behavior is preserved.
  `globalScan` remains unchanged for backward compatibility.

### Completion criteria met

- [x] `buildPageStructure` callable from both config and runtime paths
      through the same `normalizePage()` → `pageEntry.pageStructure` chain.
- [x] `PageStructure` JSON-serializable (plain objects, no Mat refs).
- [x] Existing `structuralContext`, `globalScan`, and localization contract
      untouched.
- [x] Debug overlay can consume `pageEntry.pageStructure.structuralObjects`
      in future without code changes.

## Phase 2 — Implementation record (2026-04-07)

### What was done

**`engines/wfg4/wfg4-opencv.js`**
- Added `buildConstellation(fieldBboxNorm, pageStructure, opts)` (≈185 lines).
- Pure geometry function — no OpenCV calls. Operates on the `PageStructure`
  produced by Phase 1.
- **8-sector coverage selection**: assigns every structural object to a
  directional sector (N/NE/E/SE/S/SW/W/NW from the field center); keeps the
  best-scored object per sector, then takes the top `maxMembers` (default 6)
  by score. Sectors with no candidate are left empty — partial constellations
  are valid.
- **Scoring**: `type_weight × distance_score`. Type weights: separator=3,
  row_band=2, region=1. Distance score peaks at 0.05..0.30 page-diagonals.
- **Owning region**: smallest region (by normalized area) enclosing ≥70% of
  the field bbox.
- **Object↔object relations** for all member pairs: normalized center-to-center
  distance, alignment class (`horizontal`/`vertical`/`diagonal`), horizontal
  ordering (`left_of`/`right_of`/`same_h`), vertical ordering (`above`/
  `below`/`same_v`), containment (`none`/`from_contains_to`/`to_contains_from`).
- **Nearby row bands / separators**: all bands whose mean-y is within 15% of
  page height from the field (configurable via `opts.nearbyThresholdN`).
- Exported via the module return object.

**`engines/wfg4/wfg4-registration.js`**
- After the existing structural context capture block, calls
  `CvOps.buildConstellation()` using `packet.bboxNorm` and
  `pageEntry.pageStructure` (Phase 1 result, already on the page entry).
- Sets `constellation.id = 'const-<fieldKey>'`.
- Stores result as `packet.constellation`. Fails gracefully to `null` on
  any error or if page structure is unavailable.
- Existing `structuralContext`, `visualReference`, `bbox`, `bboxNorm` are
  untouched.

### Constellation schema produced

```
{
  schema: 'wfg4/constellation/v1',
  id: 'const-<fieldKey>',
  owningRegion: { id, geom: { xN, yN, wN, hN } } | null,
  regionGeomNorm: { xN, yN, wN, hN } | null,
  coarsePagePosition: { xN, yN },
  memberCount: Number,
  members: [
    { objId, type, ref, geom: { xN, yN, wN, hN, cxN, cyN },
      sector, distN }
  ],
  relations: [
    { fromId, toId, distN, alignment, hOrder, vOrder, containment }
  ],
  nearbyRowBands:  [ { id, yN, x1N, x2N, spanN, lineCount, isSeparator } ],
  nearbySeparators:[ { id, yN, x1N, x2N, spanN, lineCount, isSeparator } ]
}
```

### Design decisions made during implementation

- 8-sector selection with stability weighting: consistent with plan (justification
  in Phase 2 plan section).
- `alignThreshN = 0.02` for both axes (2% of page dimension) for horizontal/
  vertical alignment classification.
- `nearbyThresholdN = 0.15` default (15% page height) for nearby bands.
- Type weights (separator=3, row_band=2, region=1) reflect structural
  informativeness for reconstruction.
- `memberCount` field added for quick partial-match detection without iterating
  the array.

### Fixes / deviations

- None. Phase 2 is additive only. No existing behavior changed.

### Completion criteria met

- [x] Each config packet carries a `constellation` block (or `null` if page
      structure unavailable).
- [x] Constellation is built from the shared `pageEntry.pageStructure` — no
      separate CV pass.
- [x] Schema is JSON-serializable; no Mat or canvas refs.
- [x] Existing localization contract and `structuralContext` untouched.
- [x] Graceful null on missing inputs (no throw in production path).

## Issues / blockers / fixes

- None encountered during planning. Spec is internally consistent and
  the existing per-field contract is to be preserved verbatim.

## Notes / open questions to surface (not blockers)

- Spec does not specify a transform class; Phase 6 chooses similarity →
  affine progression as the simplest stable choice.
- Spec does not specify candidate selection scoring; Phase 2 uses an
  8-sector coverage + stability heuristic.
- Spec does not bound K for runtime candidate shortlist; Phase 4 will
  default K=5 with a config knob.
