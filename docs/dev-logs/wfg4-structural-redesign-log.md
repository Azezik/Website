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
