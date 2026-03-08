# Precomputed Structural Mapping Specification

## Feature Overview

The **Precomputed Structural Mapping** feature defines a two-stage architecture for WrokitVision:

1. **Upload-time broad structural precomputation** over the full visual input.
2. **Selection-time local semantic resolution** triggered by user-drawn bounding boxes.

This architecture replaces the assumption that extraction can be solved by OCR text alone or by a single global interpretation pass. Instead, it produces a reusable structural candidate space first, then resolves meaning locally when the user indicates intent.

This feature applies to uploaded images and document-like visuals but must not assume the input is a document. The system must support receipts, invoices, screenshots, labels, packaging, photos containing text, mixed layouts, and non-axis-aligned or perspective-distorted surfaces.

The feature creates a persistent representation that can be reused across interactions and future extraction runs. It introduces typed structural graph primitives, typed relationships, and inspectable scoring logic to improve accuracy, explainability, and maintainability.

## Role Within the WrokitVision Engine

WrokitVision currently includes image processing, OCR, and extraction logic. This specification positions precomputed structural mapping as a foundational subsystem that:

- Sits between low-level visual processing and high-level field extraction.
- Feeds both interactive field configuration and future automated matching.
- Evolves and eventually supersedes legacy feature-graph logic in a controlled migration.
- Provides stable contracts that downstream extraction modules can consume without tightly coupling to OCR internals.

The subsystem is not a one-off utility; it is an engine-level architectural layer that standardizes how visual structure is represented, queried, scored, and debugged.

## Product Goal

Enable robust, reusable, user-guided extraction by introducing a broad upload-time map and a deterministic local resolution pipeline.

Desired outcomes:

- Higher resilience to layout drift and OCR noise.
- Better support for non-document inputs and rotated/perspective layouts.
- Reduced dependence on global template assumptions.
- Field signatures that are explainable, inspectable, and reusable for future matching.
- Gradual migration path from older graph approaches without disrupting existing workflows.

## Architectural Philosophy

1. **Broad first, specific later**: upload-time processing captures candidate structure only; interpretation is deferred.
2. **User intent is semantic anchor**: a drawn box is not just geometry; it selects local meaning.
3. **Locality over global classification**: avoid whole-image object-type decisions for extraction.
4. **Typed graphs over implicit heuristics**: every node and edge type is explicit and queryable.
5. **Scoring must be inspectable**: every relevance decision should be traceable.
6. **OCR is one signal among many**: structure, geometry, surfaces, and adjacency are equally important.
7. **Maintainable modularity**: clear module boundaries, stable data contracts, and extensible schemas.
8. **Debuggability by design**: overlays and logs are first-class deliverables, not afterthoughts.

## Global Upload-Time Structural Precompute

At upload time, WrokitVision executes a broad full-image analysis pass and stores a precomputed structural map. This phase must:

- Process the entire image without assuming document type.
- Produce candidate regions and relationships, not final semantic labels.
- Include text and non-text structural signals.
- Be deterministic under a fixed configuration.
- Persist artifacts for reuse by selection-time resolution and future extraction.

### Required output families

- Region proposals.
- Structural relationships.
- Text tokens.
- Text lines.
- Text blocks.
- Candidate surfaces.
- Adjacency graphs.

The precompute result is explicitly **provisional candidate structure**, never final interpretation.

## Structural Region Map Definition

The **Structural Region Map** is a typed set of candidate visual regions that partition and organize the image into meaningful geometric/visual components.

### Region sources

- Connected components and contour groups.
- Edge-density segments.
- Texture-consistent patches.
- Border-enclosed surfaces (boxes, cards, labels, panels).
- Saliency-derived clusters.
- OCR-derived grouping hints (as optional contributors, not sole source).

### Region attributes

Each region stores:

- `regionId` (stable identifier).
- `polygon` (supports non-axis-aligned geometry).
- `bbox` (axis-aligned convenience bounds).
- `orientation` (estimated local angle/normal).
- `surfaceTypeCandidate` (flat label, panel, background, unknown, etc.).
- `visualStats` (contrast, edge density, texture metrics).
- `textDensity` (token/line presence indicators).
- `confidence` (generation confidence only, not semantic confidence).
- `provenance` (which detectors contributed).

### Region map requirements

- Must support overlaps and nested containment.
- Must preserve ambiguous alternatives where confidence is similar.
- Must allow incremental refinement in later versions.
- Must remain agnostic to final field semantics.

## Text Topology Map Definition

The **Text Topology Map** represents text as structural topology rather than flat OCR output.

### Topology levels

- **Token nodes**: recognized text fragments with geometry.
- **Line nodes**: grouped tokens sharing baseline/topology proximity.
- **Block nodes**: grouped lines with shared orientation and region affinity.

### Text node attributes

- Raw text and normalized text variants.
- Polygon + bbox geometry.
- Orientation/skew estimate.
- OCR confidence and alternative hypotheses (if available).
- Parent links (token → line → block).
- Region affiliations (which structural regions contain/intersect).

### Topology relationships

- Sequential order in line.
- Vertical adjacency between lines.
- Block-level neighborhood.
- Alignment relationships (shared left edge, shared baseline, etc.).

Text topology is one layer in the total graph and cannot monopolize interpretation.

## User Selection Handling

When a user draws a bounding box for a field, WrokitVision initiates selection-time resolution.

### Selection normalization

- Preserve original polygon/bbox.
- Record interaction context (zoom, pan, page index where applicable).
- Transform into canonical image coordinate space.
- Store selection intent metadata (field name/type provided by UI).

### Selection as semantic anchor

The selection defines where relevance should begin. It does not force exact token clipping only. Instead, it anchors a local neighborhood search over the precomputed graph.

### Constraints

- No global page roaming unrelated to anchor.
- No mandatory global document classification.
- No assumption that selected text is axis-aligned or perfectly OCR-readable.

## Seed-to-Graph Association

Selection-time resolution begins by associating the user selection (seed) with graph nodes.

### Association inputs

- Selection geometry.
- Structural Region Map nodes.
- Text Topology Map nodes.
- Surface candidates.
- Existing typed adjacency edges.

### Association outputs

- Seed node set (initial relevant nodes).
- Edge-crossing candidates near seed boundary.
- Confidence-weighted seed memberships.

### Association strategy

- Intersection and IoU checks for polygons.
- Distance to region centroids and boundaries.
- Orientation compatibility checks.
- Partial overlap acceptance for noisy OCR geometry.
- Multi-seed creation when ambiguity is significant.

## Local Relevance Resolution

After seed association, WrokitVision computes local relevance in a bounded neighborhood.

### Objectives

- Identify nodes likely belonging to the selected field context.
- Include labels, values, containers, and siblings where relevant.
- Reject distant unrelated structures.

### Relevance scoring dimensions

- Graph distance from seed nodes.
- Geometric distance in local coordinates.
- Orientation compatibility.
- Region containment and co-membership.
- Text-role hints (label-like vs value-like patterns).
- Structural consistency with neighboring nodes.

### Resolution behavior

- Expand outward in limited graph hops.
- Maintain typed edge penalties/bonuses.
- Keep top-k candidate subgraphs when ambiguity persists.
- Emit inspectable score breakdowns per candidate node.

## Local Structural Reconstruction

The selected neighborhood is converted into a coherent local structure for field reasoning.

### Reconstruction tasks

- Build a local induced subgraph from relevant nodes.
- Resolve duplicate or overlapping text hypotheses.
- Identify candidate label-value pairings.
- Detect containing region and sibling regions.
- Establish row/column tendencies where present (without assuming tabular documents globally).

### Output

A normalized local structural bundle including:

- Candidate target text nodes.
- Nearby label nodes.
- Container hierarchy.
- Sibling relationships.
- Local geometric priors.

## Local Coordinate Frame Estimation

To handle non-axis-aligned layouts, the system estimates a local coordinate frame from nearby structure.

### Estimation signals

- Dominant line orientations.
- Region edge directions.
- Text baseline vectors.
- Surface boundary geometry.

### Frame outputs

- Local origin (seed-weighted centroid).
- Primary and secondary axes.
- Rotation/skew parameters.
- Optional perspective normalization hints.

### Usage

All local distances, alignment checks, and matching features for Field Signature creation should prefer this local frame over raw image axes.

## Field Signature Construction

A **Field Signature** is the persisted representation of a configured field that future matching will reuse.

### Required Field Signature contents

- Selected text tokens.
- Nearby labels.
- Structural relationships.
- Containing regions.
- Sibling structures.
- Local geometry.
- Local coordinate frame.
- Graph relationships.

### Signature design requirements

- Store typed references, not only flattened text.
- Preserve ambiguity where needed (alternative tokens/labels with scores).
- Include feature vectors suitable for future matching.
- Version the schema for migrations.
- Keep provenance and scoring traces for debugging.

### Recommended schema sections

- `fieldIdentity`: field key, user label, profile linkage.
- `seed`: selection geometry + initial seed nodes.
- `localFrame`: axes/origin/skew.
- `textFeatures`: canonical tokens, alternates, normalization forms.
- `structuralFeatures`: region/container/sibling descriptors.
- `graphFeatures`: typed neighborhood signatures.
- `confidenceModel`: per-signal scores and weights.
- `debugArtifacts`: overlay references and decision traces.

## Future Matching Behavior

Future extraction runs should match new uploads against stored Field Signatures using the same two-stage philosophy.

### Matching flow

1. Run upload-time broad structural precompute on new image.
2. For each stored Field Signature, locate likely local anchors using signature features.
3. Reconstruct local neighborhood in the candidate area.
4. Score candidate matches using text, geometry, structure, and graph consistency.
5. Select best match with confidence and trace output.

### Matching constraints

- Must not require global document classification.
- Must tolerate rotation, skew, and moderate layout drift.
- Must not depend solely on exact OCR string equality.
- Must expose confidence and fallback behavior for human review.

## Module Architecture

The refactor should be implemented as explicit modules inside WrokitVision with clear APIs.

### Top-level module domains

- `precompute`: full-image candidate map generation.
- `graph`: typed node/edge schema and graph utilities.
- `selection-resolution`: seed association, relevance scoring, local reconstruction.
- `signature`: field signature build/read/write/versioning.
- `matching`: future-run signature-to-image matching.
- `debug`: overlays, traces, score explainers.
- `migration`: adapters from legacy feature-graph outputs.

## File/Module Responsibilities

The exact file names may evolve, but responsibilities should remain stable.

- **Precompute orchestrator**: runs detectors, merges candidates, emits structural map artifact.
- **Region proposal module**: generates and scores structural regions.
- **Text topology module**: converts OCR outputs into token/line/block topology.
- **Graph builder module**: creates typed nodes/edges and adjacency indexes.
- **Selection resolver module**: maps user bbox to seed graph nodes.
- **Local relevance module**: scores neighborhood and returns candidate local subgraphs.
- **Local frame module**: estimates local coordinate frame and transforms geometry.
- **Field signature module**: constructs, validates, persists versioned signature payloads.
- **Matching module**: applies stored signatures to new precomputed maps.
- **Debug renderer module**: produces overlay layers and decision trace bundles.
- **Legacy bridge module**: temporary compatibility with old feature-graph consumers.

## Data Structures

The architecture requires typed, versioned data contracts.

### Core entity types

- `StructuralRegionNode`
- `TextTokenNode`
- `TextLineNode`
- `TextBlockNode`
- `SurfaceNode`
- `SelectionSeed`
- `LocalSubgraph`
- `LocalCoordinateFrame`
- `FieldSignature`
- `MatchCandidate`
- `ScoreBreakdown`

### Edge types (examples)

- `CONTAINS`
- `INTERSECTS`
- `ADJACENT`
- `ALIGNED_WITH`
- `SEQUENTIAL_NEXT`
- `LABEL_FOR_CANDIDATE`
- `SIBLING_OF`
- `ON_SURFACE`

### Data contract requirements

- Every node includes `id`, `type`, geometry, confidence, provenance.
- Every edge includes `source`, `target`, `type`, weight, and rationale metadata.
- Contracts are serializable and backward-compatible via versioning.
- Optional fields are explicit; missing data is represented consistently.

## Processing Pipeline

### Stage A: Upload-Time Precompute

1. Ingest image and normalize coordinate space.
2. Run structural region proposal detectors.
3. Run OCR and build text token primitives.
4. Build text lines and text blocks from tokens.
5. Detect candidate surfaces and non-text structures.
6. Build typed graph and adjacency indexes.
7. Persist precomputed structural artifact.

### Stage B: Selection-Time Resolution

1. Capture and normalize user selection bbox.
2. Associate selection seed to graph nodes.
3. Run local relevance scoring in bounded neighborhood.
4. Reconstruct local structural context.
5. Estimate local coordinate frame.
6. Construct and persist Field Signature.
7. Emit debug traces/overlays for inspection.

### Stage C: Future Extraction Matching

1. Precompute structure for new upload.
2. For each Field Signature, find candidate anchor neighborhoods.
3. Reconstruct local context and score candidate matches.
4. Return extracted value + confidence + rationale.
5. Surface low-confidence results for review.

## Debug Visualization Requirements

Debug visibility is mandatory.

### Required overlay layers

- Region proposals and confidences.
- Text tokens/lines/blocks with orientation.
- Surface candidates.
- Typed graph edges (toggle by edge type).
- User selection seed and associated seed nodes.
- Local relevance heatmap.
- Local coordinate frame axes.
- Final Field Signature components (labels, value tokens, containers, siblings).

### Required inspectable outputs

- Node/edge score breakdowns.
- Relevance ranking table.
- Match candidate comparison table.
- Confidence composition per field.
- Serialized trace bundle for offline debugging.

## Implementation Phases

### Phase 0 — Specification Lock (current)

- Finalize this architecture document.
- Align stakeholders on boundaries, contracts, and migration intent.

### Phase 1 — Typed Graph Foundation

- Introduce typed node/edge schemas and serializers.
- Implement graph builder abstractions with tests.
- Add compatibility adapters for legacy consumers.

### Phase 2 — Upload-Time Precompute

- Implement region, text topology, and surface map generation.
- Persist structural map artifacts.
- Add debug overlays for upload-time outputs.

### Phase 3 — Selection-Time Resolution

- Implement seed association and relevance scoring.
- Build local reconstruction and local frame estimation.
- Construct versioned Field Signature payloads.

### Phase 4 — Matching Engine

- Implement signature-based matching on future uploads.
- Add confidence/rationale reporting.
- Integrate low-confidence review signals.

### Phase 5 — Migration and Hardening

- Migrate workflows from legacy feature-graph logic.
- Run A/B and regression validation.
- Optimize performance and memory.
- Finalize operational monitoring.

## Acceptance Criteria

The refactor is accepted when all criteria below are met:

1. Upload-time processing generates a broad structural and text map for any visual input without requiring document classification.
2. Precomputed artifacts include region proposals, structural relationships, text tokens/lines/blocks, candidate surfaces, and adjacency graphs.
3. Selection-time resolution uses user bbox as a semantic anchor and resolves local relevant structure from precomputed data.
4. Field Signature output contains all required elements: selected tokens, nearby labels, structural relationships, containing regions, sibling structures, local geometry, local coordinate frame, and graph relationships.
5. Matching pipeline can reuse Field Signatures on future uploads with confidence/rationale outputs.
6. Typed graph schema and typed edges are implemented and inspectable.
7. Scoring logic is explainable via score breakdown artifacts.
8. Debug overlays cover upload-time, selection-time, and matching-time decisions.
9. Architecture does not assume document-only inputs, axis-aligned layouts, or OCR-only extraction.
10. Module boundaries and data contracts are versioned and maintainable within WrokitVision.

---

This document is the canonical architecture reference for the WrokitVision precomputed structural mapping refactor and is intended to guide implementation work before code changes begin.
