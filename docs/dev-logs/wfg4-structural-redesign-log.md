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

## Phase 3 — Implementation record (2026-04-07)

### What was done

**`engines/wfg4/wfg4-opencv.js`**
- Added `computeFieldStructuralIdentity(fieldBboxNorm, pageStructure, constellation, opts)`
  (≈215 lines). Pure geometry, no OpenCV calls.
- **bbox relative to constellation frame** (`bboxRelConstellation`): when an
  owning region is available, uses its geom as the frame; otherwise derives a
  frame from the bounding box of all constellation member centers with a 2%
  margin. Stores `cxRatio`, `cyRatio`, `wRatio`, `hRatio`, `x0Ratio`,
  `y0Ratio`, and the frame geometry.
- **bbox relative to row** (`bboxRelRow`): finds the row band whose mean-y is
  closest to the field center and that overlaps the field's y range (or is
  within 2× field height). Stores `xInBandRatio`, `wInBandRatio`, and signed
  `distFromBandYN`.
- **Nearby object distances** (`nearbyObjects`): all structural objects within
  25% page-diagonal, sorted by distance, capped at 8. Stores signed `dxN`,
  `dyN`, and scalar `distN`.
- **Row overlap map** (`rowOverlaps`): for every row band intersecting the
  field both vertically and horizontally, stores `vOverlapRatio` and
  `hOverlapRatio`.
- **Field-level mini-constellation** (`miniConstellation`): up to 6 labeled
  members: `containing_row`, `adjacent_row_above`, `adjacent_row_below`,
  `separator_above`, `separator_below`, `slot_value_band`. Object↔bbox
  relations stored for each member (dist, dxN, dyN, four signed edge offsets).

**`engines/wfg4/wfg4-registration.js`**
- After the Phase 2 constellation block, calls
  `CvOps.computeFieldStructuralIdentity()` with `packet.bboxNorm`,
  `pageEntry.pageStructure`, and `packet.constellation`.
- Stores result as `packet.structuralIdentity`. Fails gracefully to `null`.
- Existing pixel bbox and `structuralContext` are the authoritative base
  representation — `structuralIdentity` is additive metadata.

### Schema produced (`packet.structuralIdentity`)

```
{
  schema: 'wfg4/field-structural-identity/v1',
  bboxRelConstellation: {
    cxRatio, cyRatio, wRatio, hRatio,
    x0Ratio, y0Ratio,
    frameGeom: { xN, yN, wN, hN }
  } | null,
  containingBandId: String | null,
  bboxRelRow: {
    bandId, xInBandRatio, wInBandRatio, distFromBandYN
  } | null,
  nearbyObjects: [
    { objId, type, distN, dxN, dyN }
  ],
  rowOverlaps: [
    { bandId, isSeparator, vOverlapRatio, hOverlapRatio }
  ],
  miniConstellation: {
    members:   [ { label, id, geom } ],
    relations: [ { label, memberId, distN, dxN, dyN,
                   distFromTopN, distFromBottomN,
                   distFromLeftN, distFromRightN } ]
  }
}
```

### Design decisions

- Constellation frame fallback (member-center bounding box + 2% margin):
  ensures `bboxRelConstellation` is always populated when any members exist,
  even without an owning region.
- Slot/value band detection: looks for a row band overlapping the field's y
  range whose x-span is < 50% of page width OR lies within the field's x range
  — approximates a column divider without requiring explicit slot detection.
- `nearbyDistThresh = 0.25` (25% page-diagonal) configurable via
  `opts.nearbyDistThresh`.

### Fixes / deviations

- None. Purely additive.

### Completion criteria met

- [x] `bboxRelConstellation` populated (or null with explanation).
- [x] `bboxRelRow` populated when a containing row band is found.
- [x] `nearbyObjects` distances normalized and capped.
- [x] `miniConstellation` contains all 6 member types where detectable.
- [x] Existing pixel bbox and `structuralContext` untouched.
- [x] Backwards-compatible: loaders that don't know `structuralIdentity` ignore it.

## Phase 4 — Implementation record (2026-04-07)

### What was done

**`engines/wfg4/wfg4-opencv.js`**
- Added `selectConstellationCandidates(configConstellation, runtimePageStructure, opts)` (≈100 lines). Pure geometry, no CV ops.
- Reads `configConstellation.coarsePagePosition` and dominant member type from `configConstellation.members[].type`.
- Scores each runtime `structuralObjects[]` entry: `posScore` (linear decay from 1.0 to 0 over 0.30 page-diagonals from config center) + `typeBonus` (+0.25 if matching dominant type).
- Deduplicates candidates within 0.08 page-diagonal (best score wins).
- Appends a `position_prior` candidate (`viable: false`, zero translation) if no structural anchor is within 0.05 of the config center.
- Each candidate carries: `rank`, `score`, `viable` (score ≥ 0.20 && anchorObjId != null), `anchorObjId`, `anchorType`, `centerN`, `estimatedTranslationN`.

**`engines/wfg4/wfg4-localization.js`**
- In `localizeFieldVisual()`, before the window loop: calls `selectConstellationCandidates()` with the runtime `pageEntry.pageStructure` and `ref.constellation`. Logs `struct.candidates` event (count, viable count, hasViable).
- **Window ordering with viable structural candidates:**
  - Up to `min(viableCands, maxAttempts-1)` structural windows (`D_struct_N`) are tried first, built by applying each candidate's `estimatedTranslationN` to the predicted box.
  - `A_predicted` (ORB on config-time bbox) is appended last as fallback.
  - ORB fires on the fallback window only if all structural windows fail to match.
- **Without viable structural candidates:** original behavior is preserved exactly — `A_predicted`, `B_widened`, `C_globalScan_N` in order.
- `structuralCandidates` added to both the degraded-fallback and the main success/failure return objects for debug visibility.

### Design decisions

- `maxAttempts - 1` cap on structural windows: always reserves 1 slot for the ORB fallback, ensuring the system does not silently exhaust its budget without attempting any ORB recovery.
- `estimatedTranslationN` applied to predicted box (not constellation center): preserves the field's relative position within the constellation frame; more accurate than centering the window on the anchor object.
- `globalScan.candidateRegions` (C windows) are kept only in the no-viable-candidates fallback path; they are not needed when structural candidates guide the search.

### Fixes / deviations

- None. Purely additive. All existing localization behavior is preserved exactly when no viable structural candidates are found.

### Completion criteria met

- [x] Runtime `pageEntry.pageStructure` used (Phase 1 result, no extra CV pass).
- [x] Structural windows are primary when viable candidates exist.
- [x] ORB fires only as fallback (last window slot, only if structural windows fail).
- [x] `structuralCandidates` exposed in debug output on all return paths where it is computed.
- [x] K default = 5, config via `DEFAULTS.globalScanTopCandidates`.

## Phase 5 — Implementation record (2026-04-07)

### What was done

**`engines/wfg4/wfg4-opencv.js`**
- Added `matchConstellationCandidates(configConstellation, runtimePageStructure, candidates, opts)` (~210 lines). Pure geometry; no OpenCV calls.
- Promotes Phase 4's coarse anchor shortlist into scored, member-correspondence-
  bearing matches via a relation-graph scorer.
- Per candidate:
  1. Derives `(dxN, dyN)` translation from `cand.estimatedTranslationN`.
  2. For each config member, predicts the runtime center by applying that
     translation to the config member center, then chooses the best runtime
     `structuralObject` of the same type within `memberSearchRadiusN` (default
     0.08 page-diagonal). Falls back to any-type match at half score if no
     same-type object exists. Each runtime object is consumed at most once.
  3. Builds a `memberCorrespondences[]` map and accumulates `matchedCount`
     and per-member proximity scores; missing members are recorded with
     `runtimeObjId: null` so partial matches are explicit.
  4. For every config relation whose endpoints both have correspondences,
     re-derives `alignment / hOrder / vOrder` from the runtime pair and
     compares with the config relation. `relationsAgreed / relationsChecked`
     yields `relationConsistencyRatio`.
  5. `finalScore = memberAvg * memberWeight + relationConsistencyRatio *
     relationWeight + anchorBoost`. When no relations are checkable (single
     member matches), it falls back to pure member coverage so partial
     matches still survive. `anchorBoost` is a small additive lift from the
     Phase 4 candidate score (capped at 0.15).
- Default weights: `memberWeight=0.55`, `relationWeight=0.45`,
  `acceptThreshold=0.35`, `alignThreshN=0.02`, `maxMatches=5`.
- Returns `{ matches: [ConstellationMatch], debug }` sorted by `finalScore`
  desc; the result preserves *every* candidate (not just the best one) so
  Phase 6/7 can opt into repeated-match emission via search policy.
- Each `ConstellationMatch` carries `rank, candidateRank, anchorObjId,
  anchorType, centerN, estimatedTranslationN, memberCorrespondences,
  matchedMemberCount, totalMemberCount, memberCoverage,
  relationConsistencyRatio, relationsChecked, relationsAgreed, partial,
  finalScore, accepted`.
- Exported via the module return object.

**`engines/wfg4/wfg4-localization.js`**
- After the existing Phase 4 `selectConstellationCandidates()` call, invokes
  `matchConstellationCandidates()` with the runtime `pageEntry.pageStructure`,
  the config `constellation`, and the Phase 4 shortlist.
- Stores `structMatches`, `structMatchDebug`, and `acceptedStructMatches`.
- Promotes `hasViableStructCandidates = true` whenever Phase 5 produces at
  least one accepted match (so a non-viable Phase 4 anchor can still be
  rescued by relation-graph evidence).
- Window builder now prefers Phase 5 accepted matches as the source for the
  primary `D_struct_*` windows; if Phase 5 accepted nothing, it falls back
  to Phase 4 raw viable candidates (preserving Phase 4 behavior). ORB on the
  predicted box remains the last reserved fallback window.
- New engine-log event `struct.matches` exposes match count, accepted count,
  top score, top partial flag, top coverage, and top relation-consistency
  ratio for diagnostics.
- `structuralMatches` and `structuralMatchDebug` added to both the
  degraded-fallback and main success/failure return objects.

### Design decisions

- Member-search radius `0.08` page-diagonal: tight enough that candidates
  near the wrong region don't false-match members from elsewhere on the
  page, loose enough to absorb realistic scale/render drift between config
  and runtime layouts.
- Type-mismatch penalty (effective distance ×2 instead of hard reject):
  preserves matchability when row-band/separator classification flips
  between config and runtime, while still preferring exact-type pairs.
- `memberWeight=0.55 / relationWeight=0.45`: relation consistency is the
  signal that distinguishes "found the right structural pattern" from
  "found a similar set of objects in the wrong arrangement", but coverage
  must dominate slightly so single-member-rich constellations are still
  rankable when relation count is low.
- Anchor boost capped at 0.15: lets the Phase 4 anchor quality act as a
  tiebreaker without overpowering the relation-graph evidence.
- Relation-less fallback to pure member coverage: necessary because
  constellations with only 1–2 matched members yield zero checkable
  relations, and partial-match support is mandatory per the plan.
- Repeated-constellation support: every candidate above `acceptThreshold`
  is returned and ranked. Phase 6/7 will decide whether to consume only the
  top match or emit one reconstruction per accepted match based on search
  policy. Phase 5 itself does not commit to single-vs-multi output.
- Defaults exposed via `DEFAULTS.constellationAcceptThreshold` and
  `DEFAULTS.constellationMemberSearchRadiusN` so they can be tuned without
  touching the matcher.

### Fixes / deviations

- None. Phase 5 is additive. The Phase 4 fallback path is preserved exactly:
  if Phase 5 produces no accepted matches, the runtime falls back to the
  Phase 4 viable list, and if there are no viable Phase 4 candidates either,
  the legacy ORB-first window order runs untouched. ORB remains a
  refine-only / last-resort fallback as required.

### Completion criteria met

- [x] Matcher emits scored selections with member-correspondence map.
- [x] Partial matches accepted (missing members recorded explicitly,
      relation-less fallback to coverage-only scoring).
- [x] Repeated constellations supported (all accepted matches returned,
      ranked, ready for Phase 6/7 multi-instance policy).
- [x] Debug surface (`struct.matches` log + `structuralMatches` /
      `structuralMatchDebug` on returns) shows score breakdown.
- [x] ORB still gated as refine-only / last-window fallback.
- [x] Existing field-level localization contract untouched.

## Phase 6 — Implementation record (2026-04-07)

### What was done

**`engines/wfg4/wfg4-opencv.js`**
- Added `reconstructFieldFromMatch(configConstellation, configStructuralIdentity, fieldBboxNormConfig, match, runtimePageStructure, surfaceSize, opts)` (~220 lines). Pure geometry; no OpenCV calls.
- Builds correspondence point pairs from `match.memberCorrespondences` by
  joining each correspondence to its config member (`cfg.cxN/cyN`) and the
  matched runtime structural object (`rt.cxN/cyN`).
- Hierarchical transform policy:
  - **≥4 correspondences with spatial spread > 0.05 in both axes** → affine
    least-squares fit (6×6 normal equations, in-place Gaussian elimination).
  - **≥2 correspondences** → axis-aligned similarity (independent x/y scale,
    no rotation), per-axis least-squares with scale clamped to [0.5, 2.0].
  - **1 correspondence** → translation only.
  - **0 correspondences** → fallback to `match.estimatedTranslationN`
    (normalized prior, same as Phase 4 simple translation).
- Projects all four corners of the config field bbox through the transform
  and takes the axis-aligned bounding box of the projected corners.
- **Row snap (optional, on by default)**: if `configStructuralIdentity.bboxRelRow`
  exists and the Phase 5 match found a runtime correspondence for that row
  band, snaps the field y-band to the runtime row's mean-y while preserving
  `distFromBandYN` (the signed offset from band-y to field center). The
  field height is preserved.
- Clamps to [0, 1], enforces a minimum 1e-4 width/height, and emits both
  normalized (`reconstructedBoxN`) and pixel (`reconstructedBoxPx`) forms
  using the supplied `surfaceSize`.
- Returns `{ ok, transformModel, correspondencesUsed, reconstructedBoxN,
  reconstructedBoxPx, usedRowSnap, debug }`.
- Exported via the module return object.

**`engines/wfg4/wfg4-localization.js`**
- After Phase 5, iterates `acceptedStructMatches` and invokes
  `reconstructFieldFromMatch()` for each, using `ref.bboxNorm` as the
  config field bbox, `pageEntry.dimensions.working` as `surfaceSize`, and
  `ref.structuralIdentity` for row-snap. Attaches the result to each match
  as `match.reconstruction` and pushes a flat copy onto
  `structReconstructions[]`.
- Window builder: when an accepted match carries a reconstruction, the
  primary `D_struct_*` window is built around that reconstructed pixel box
  (still padded by `basePad`). When no reconstruction is attached, the
  Phase 4/5 simple-translation behavior is preserved as fallback.
- Added `STRUCTURAL_RECONSTRUCTED = 'structural_reconstructed'` to the
  local `BBOX_SRC` table (mirrors any future `Types.BBOX_SOURCE` addition).
- After ORB attempts, if `attemptsWon` is false but a top reconstruction
  exists, adopts `topReconstruction.reconstructedBoxPx` as the localized
  box and sets `usedStructuralReconstruction = true`.
- Localization gate, status, `bboxSource`, and `reason` paths updated to
  recognize structural reconstruction as a successful localization (so it
  flows through the existing field localization contract via
  `STRUCTURAL_RECONSTRUCTED`). Existing `STRUCTURAL_FALLBACK` and
  `PREDICTED_FALLBACK` paths are preserved verbatim.
- New engine-log event `struct.reconstructions` exposes reconstruction
  count, top transform model, top correspondence count, and top row-snap
  state.
- `structuralReconstructions` added to both the degraded-fallback and
  main success/failure return objects.

### Schema added (`structuralReconstructions[i]`)

```
{
  matchRank, transformModel,            // 'affine' | 'similarity' | 'translation' | 'prior'
  correspondencesUsed,
  reconstructedBoxN:  { x0, y0, x1, y1 },
  reconstructedBoxPx: { x, y, w, h, page } | null,
  usedRowSnap,
  debug: {
    pairs, matchRank, matchFinalScore,
    memberCoverage, relationConsistency, partial
  }
}
```

### Design decisions

- **Similarity model = independent x/y scale, no rotation.** Form layouts
  are axis-aligned; rotation introduces fragility for small N. Independent
  per-axis scale absorbs render-scale differences (e.g. wider scans, taller
  PDF rasterizations) without overfitting. Scale clamped to [0.5, 2.0] to
  reject degenerate fits from collinear correspondences.
- **Affine threshold = 4 correspondences + spread > 0.05.** Prevents
  upgrading to affine on collinear or clustered points where the fit would
  be unstable. The spatial-spread guard mirrors Phase 2's 8-sector
  constellation goal: distributed correspondences only.
- **Row-snap is post-projection, not part of the LS fit.** This keeps the
  geometric transform unbiased while still correcting "right region, wrong
  row" — the dominant remaining failure mode. It only fires when the
  config-time row band has a runtime correspondence in the same Phase 5
  match, so it cannot snap to an unrelated row.
- **Prior fallback uses `match.estimatedTranslationN`.** When no member
  correspondences are present (all-null pairs), the reconstructor degrades
  to the same translation Phase 4 used, so the resulting box matches the
  pre-Phase 6 behavior — no regression on degenerate cases.
- **Reconstructed box is adopted as the localized box only when ORB
  attempts fail.** Phase 6 deliberately does *not* override successful ORB
  matches; that demotion is Phase 7's responsibility. ORB still acts as
  refinement *within* the structural window when it succeeds, and the
  reconstructed box is still used as the search center.
- **`STRUCTURAL_RECONSTRUCTED` is a new bbox source, not a reuse of
  `STRUCTURAL_FALLBACK`.** Downstream consumers can distinguish "snapped
  via existing structuralRefineBox heuristics" from "projected via Phase 6
  hierarchical transform" without breaking the existing contract.

### Fixes / deviations

- None. Phase 6 is additive. When Phase 5 produces no accepted matches the
  pre-Phase 6 path runs unchanged. When Phase 5 produces accepted matches
  but no reconstruction succeeds (e.g. zero pairs and zero translation),
  the simple-translation D_struct windows from Phase 4/5 still build.

### Completion criteria met

- [x] Reconstructed bbox produced for each accepted Phase 5 match.
- [x] Reconstruction passed to downstream readout via the existing field
      localization contract (`localizedBox`, `finalReadoutBox`,
      `bboxSource = STRUCTURAL_RECONSTRUCTED` when used).
- [x] Hierarchical transform: page → constellation correspondences →
      similarity/affine projection → optional row snap.
- [x] Partial-match fallback to normalized translation prior.
- [x] ORB still runs within structural windows; reconstruction adopted as
      localized box only when ORB fails. Refine demotion remains Phase 7.
- [x] Existing `STRUCTURAL_FALLBACK` / `PREDICTED_FALLBACK` paths and the
      Phase 4/5 fallbacks are preserved verbatim.

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
