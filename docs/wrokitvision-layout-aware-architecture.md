# WrokitVision Deterministic Scene-Aware Extraction (Two-Map Architecture)

## Purpose
Refine WrokitVision into a deterministic, explainable extraction engine that understands document/image scene structure before field extraction, while preserving the existing product shell:

- wizard UI,
- dashboard,
- batch processing,
- MasterDB,
- extraction result flow.

This design stays deterministic (rule/score driven), profile-based, and debuggable.

---

## 1) Alignment with the previous proposal

Your direction is fully aligned with the prior layout-aware architecture and strengthens it in three key ways:

1. **Per-geometry seed structural graph** as a persisted source-of-truth artifact.
2. **Prototype refinement-ready storage** (without requiring immediate implementation).
3. **Text-map-first runtime order**, where structural extraction uses text-aware masking/discounting.

This improves determinism by making each geometry self-contained, versioned, and auditable.

---

## 2) Core runtime model: Two deterministic maps

## A. Relational Text Map (generated first)

### Goal
Represent all OCR words as a geometry-aware graph, not just per-field local anchors.

Each OCR token is a node:

```ts
TextNode {
  id,
  text,
  normalizedText,
  bbox,
  centroid,
  lineId,
  confidence
}
```

Edges encode:
- same-line relation,
- near-right / near-below,
- row/column alignment,
- distance bands,
- grouping clusters.

Graph: `G_text = (V_text, E_text)`.

### Why first?
`G_text` is used to build a **text influence mask** so dense word regions can be discounted during structural feature extraction, reducing text-polluted structural nodes while preserving mixed areas (panels, table cells, bordered labels).

## B. Structural Visual Map (text-aware non-text scene understanding)

### Goal
Identify stable foreground structures against dominant background surface(s), without semantic object classification.

### B1. Dominant background surface estimation

**Definition:** not literal RGB capture, but identification of the largest low-information region(s) representing background support.

Examples:
- white paper area in scan,
- sky behind gas tower,
- uniform signboard surround.

### Deterministic method
1. Compute low-frequency luminance map + local variance map.
2. Segment candidate low-information regions by thresholds (variance, gradient magnitude).
3. Keep largest connected region(s) with smoothness constraints.
4. Produce `backgroundMask` + `backgroundConfidence`.

### B2. Text-aware structural feature extraction
Treat deviations from background as structural foreground, while using `G_text` to suppress or down-weight pure text regions.

Extract feature primitives:
- long edges/lines,
- contours and rectangular panels,
- high-contrast blobs (logos/icons),
- connected components,
- repeated band structures (e.g., stacked price rows).

Each feature becomes a deterministic node:

```ts
StructuralNode {
  id,
  type, // line, box, blob, panel, band
  bbox,
  centroid,
  orientation,
  scale,
  contrastScore,
  textOverlapScore, // from text influence mask
  stabilityScore
}
```

### B3. Structural feature graph
Build `G_struct = (V_struct, E_struct)` where edges encode:
- relative distance,
- angle,
- alignment,
- containment,
- adjacency.

All geometry normalized by image size for scale robustness.

---

## 3) Seed structural graph per geometry (new source-of-truth rule)

Each configured geometry must generate one **seed structural graph** before field box drawing starts in config mode.

### Required behavior
- Wizard with N geometries -> persist N seed graphs.
- Seed graph is first-class and versioned with geometry/profile metadata.
- Seed graph is the structural source of truth for that geometry’s alignment/extraction.

### Persistence model (conceptual)

```ts
GeometryArtifact {
  geometryId,
  profileVersion,
  seedStructuralGraph,   // required for v4+
  seedTextGraphSummary,  // optional compact anchor summary
  createdAt,
  updatedAt
}
```

### Runtime usage
- Load geometry-specific seed graph.
- Match runtime `G_struct` to that seed graph.
- Use match quality in field localization and confidence.

This avoids cross-geometry contamination and keeps behavior deterministic.

---

## 4) Config-time behavior (wizard)

When user draws a field bbox, save not only rectangle geometry but a local neighborhood descriptor from both maps.

For each field `F`, persist:

1. **BBox anchor** (existing, primary)
2. **Structural neighborhood** from geometry seed graph:
   - nearest structural nodes,
   - relative offsets/angles,
   - local structural signature.
3. **Text neighborhood** from `G_text`:
   - nearby anchor words/synonyms,
   - expected directional relations (right/below/same-line),
   - local mini-constellation edges.
4. **Value fingerprint** (existing OCRMagic/data-type constraints)
5. **Search policy**:
   - micro-expansion steps/cap,
   - allowed neighborhood radius,
   - fallback behavior (never-null best candidate).

This defines the field as a localized deterministic neighborhood inside both maps.

---

## 5) Runtime behavior (deterministic sequence)

For each incoming page/image:

1. Build OCR token set and `G_text` first.
2. Build text influence mask from `G_text`.
3. Build `backgroundMask` and structural foreground.
4. Build text-aware `G_struct` from non-text features.
5. Coarsely align scene to geometry seed graph (if available).
6. For each field, begin at saved bbox (required), then:
   - apply local structural neighborhood constraints,
   - apply local text-neighborhood/label constraints,
   - run bbox-first + micro-expansion extraction,
   - rank candidates by deterministic score.
7. Normalize/correct value with OCRMagic + fingerprints.
8. Emit value + confidence + rationale trace.

This keeps the core principle intact: extraction starts from the saved bbox and expands only locally.

---

## 6) Deterministic scoring/fusion

For scalar field candidate `c`:

`Score(c) = a*BboxProximity + b*LabelRelation + c*TextFormat + d*StructuralFit + e*CrossFieldChecks`

Where:
- `BboxProximity`: closeness to bbox center/label.
- `LabelRelation`: right-of/below label consistency.
- `TextFormat`: date/money/code grammar confidence.
- `StructuralFit`: fit to expected local structure from seed graph.
- `CrossFieldChecks`: arithmetic or row consistency bonuses.

Tie-break:
1. nearest to label,
2. nearest to bbox center,
3. higher OCR confidence.

If strict pattern fails, return best nearby candidate as low confidence (never null by default).

---

## 7) Prototype refinement-ready design (future, not required now)

Design artifacts to support later **prototype strengthening** per geometry:

- Input: small set of successful runtime graphs (`G_struct_runtime`) with high-confidence matches.
- Process: align to seed graph, vote for stable nodes/edges, decay unstable landmarks.
- Output: refined prototype graph (single strengthened graph), not unbounded raw accumulation.

### Refinement constraints
- bounded sample window,
- high-confidence gate,
- deterministic merge rules,
- full lineage/audit trail,
- rollback to original seed graph.

### Suggested artifact model

```ts
PrototypeGraphState {
  geometryId,
  baseSeedGraph,
  refinedGraph,          // optional until refinement enabled
  refinementEpoch,
  acceptedSampleCount,
  rejectedSampleCount,
  lineage[]              // deterministic change log
}
```

This keeps refinement optional while ensuring storage and schema are future-proof.

---

## 8) Module breakdown (implementable)

## 8.1 Minimal useful version (MVP)

### Scope
Deliver value quickly with low risk, no shell changes.

### Modules
1. `text/full-constellation-builder`
   - build `G_text` first from OCR tokens.
2. `vision/text-influence-mask`
   - derive suppression/discount map from `G_text`.
3. `vision/background-estimator`
   - output: `backgroundMask`, `backgroundConfidence`.
4. `vision/structural-features-lite`
   - text-aware detection of panels/lines/connected components.
5. `runtime/geometry-seed-aligner`
   - align runtime structure to per-geometry seed graph.
6. `runtime/localization-fuser`
   - combines saved bbox + local text neighborhood + structural hints.
7. `runtime/extraction-scorer-v2`
   - deterministic weighted ranking with explainability payload.

### Expected MVP gain
- cleaner structural graph quality in text-dense layouts,
- better localization under moderate camera variation,
- fewer wrong-field hops for repeated labels,
- improved explainability with map-based traces.

## 8.2 Advanced version (later)

### Additions
1. Full structural graph matcher + homography estimation.
2. Multi-template variant resolver (brand/layout families).
3. Prototype refinement engine (strengthen persistent landmarks).
4. Guard-region reasoning (where extraction must not occur).
5. Temporal smoothing for repeated sources (same camera/site feeds).
6. Rich debug overlays:
   - text influence mask,
   - background mask,
   - structural nodes/edges,
   - text graph anchors,
   - per-field search rings and score contributions.

---

## 9) Gas station tower walkthrough

1. `G_text` is built first; label anchors (`GAS`, `DIESEL`) are detected.
2. Text influence mask reduces text-edge pollution in structural extraction.
3. Background estimator identifies sky/ambient as dominant background.
4. Foreground map isolates tower-like structure and panel bands.
5. Runtime structure aligns to geometry seed graph.
6. Extraction stays bbox-first with local micro-expansion only.
7. Numeric grammar/fingerprint correction validates output format.
8. Confidence reflects structural fit + label relation + numeric validity.

Result: deterministic, explainable extraction under angle/scale/lighting variation.

---

## 10) Compatibility with existing Wrokit shell

No required changes to core shell workflows.

- **Wizard UI:** keep current field drawing; add internal seed-graph generation per geometry before box placement.
- **Batch processing:** map-building and seed alignment are internal per document/geometry.
- **MasterDB:** store seed graph artifacts and optional refinement state in versioned fields.
- **Extraction flow:** return schema remains value + confidence; rationale payload is additive.

Adopt via feature flags in WrokitVision engine only.

---

## 11) Profile/versioning strategy

Current profiles are version 3; introduce version 4 with geometry-scoped artifacts.

Add optional fields:
- `geometryArtifacts[geometryId].seedStructuralGraph` (required once v4 geometry created)
- `geometryArtifacts[geometryId].seedTextGraphSummary` (optional)
- `fieldStructuralNeighborhoods`
- `fieldTextNeighborhoods`
- `prototypeGraphState` (optional, future refinement)
- `runtimePolicies` (weights, micro-expansion caps)

Migration:
- v3 -> v4: initialize empty geometry artifacts.
- First v4 config run per geometry: generate/persist seed graph.
- If v4 artifacts absent, use existing v3 extraction path unchanged.

Use existing save/load helpers for compact storage and backward compatibility.

---

## 12) Why this remains deterministic and explainable

- No black-box end-to-end model is required.
- Every stage is rule/geometry/score based.
- Search remains locally bounded by configured bboxes and micro-expansion limits.
- Seed graph is explicit per geometry and versioned.
- Prototype refinement (if enabled later) uses deterministic merge/vote rules with lineage.
- Every extracted value can expose:
  - winning candidate,
  - rejected alternatives,
  - score breakdown,
  - structural/text evidence.

This preserves Wrokit’s deterministic identity while extending it toward deterministic document computer vision.

---

## Recommendation
Implement incrementally in WrokitVision:

1. Enforce per-geometry seed graph creation/persistence in config flow.
2. Run text-map-first extraction pipeline (text influence before structural graphing).
3. Keep bbox-first extraction as mandatory field-local anchor.
4. Add prototype refinement only after MVP quality benchmarks are met.

This path is practical, explainable, and compatible with existing Wrokit infrastructure.
