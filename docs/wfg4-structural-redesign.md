WFG4 Structural Redesign Prompt

We are working on the WFG4 engine and extraction pipeline.

Please review the dev log and architecture MD before proceeding.

This is an implementation task. Do not perform another broad rediscovery audit. Work from the current understanding and implement the next coherent structural redesign.

Core understanding so far

We have learned several important things:

WFG4 can often find the correct general area of the page.
The structural overlay shows that line detection, container detection, and regional structure are often reasonably good.
The main weakness is that the engine is still too focused on neighborhood/image matching and not strong enough at identifying the actual field target inside the matched region.
Localization often finds the correct section, but not the correct slot/row/value box inside that section.
Prior work already fixed important contract issues around localization vs readout and PDF/token dependency. That work must not be disturbed unnecessarily.

The current WFG4 engine is still mostly:

neighborhood ORB alignment
field template refine
light structural heuristics afterward

rather than true structure-led field localization.

Scope boundaries

This task focuses on improving the structural/localization model.

Do not reopen or redesign work related to:

PDF text layer behavior
token-source selection
localized OCR fallback
localization-authoritative readout contract
image vs PDF backend selection after localization

These are out of scope unless a small plumbing change is absolutely required.

Architectural direction

We want to move WFG4 toward this model:

Identify the correct structural field target, reconstruct the bbox from structure, then refine locally.

This should be implemented as a three-level system:

1. Page structure

Page-wide structural segmentation and object detection.

2. Constellation-level matching

A local structural frame representing a reusable structural pattern.

3. Field-level reconstruction

Precise identification and reconstruction of the field inside the matched constellation.

CONFIG-TIME MODEL
Config flow (explicit)

Config must operate in three stages:

Page-wide structural prepass
Constellation construction around the configured field
Field-level structural identity capture
1. Page-wide structural prepass (config)

Formalize structural detections into reusable page objects.

These should include where feasible:

major regions / containers
horizontal row bands
separators / line structures
candidate structural objects

These must become real data structures, not just overlay artifacts.

2. Constellation modeling (config)

Each configured field must belong to a constellation-level structural frame.

A constellation represents a reusable structural pattern on the page.

For each configured field, store:

Constellation identity
owning region or container
region geometry (normalized)
relative placement on page (coarse)
Internal constellation structure
row bands inside the constellation
separator patterns
neighboring structural objects
relative arrangement between those objects
Object-to-object relationships
relative distances (normalized)
alignment (left/right/center)
containment / overlap
ordering (above/below, before/after)

This forms a small structural graph, not a single anchor.

3. Field-level structural identity (config)

Each field must be defined relative to its constellation.

Store:

bbox relative to constellation (center, width, height as ratios)
bbox relative to row/slot where possible
distances to nearby structural objects (normalized)
overlap relationships with row bands / slot areas
local neighboring structural objects

Also store a small field-level constellation:

row containing the field
nearest separator
adjacent rows
relevant slot/value band if detectable

This must include both:

object ↔ object relationships
object ↔ bbox relationships
4. Constellation selection rules (config)

When building constellations:

Do not simply choose nearest objects.

Instead:

prefer a small (3–6 objects), stable, structurally meaningful set
prefer spatially distributed objects (avoid clustering on one side)
use sector-aware or coverage-aware selection when possible
allow missing directions if no stable object exists
prioritize:
row bands
separators
meaningful neighboring regions
slot/value structures

Goal:

The constellation should constrain the geometry of the field or region, not just describe it redundantly.

5. Transformation policy (config)

Structural identity must be stored in normalized coordinate systems.

store geometry relative to constellation (not just page)
store ratios (position, size, spacing)
store relationships in scale-invariant form

Do not rely on raw page pixel coordinates.

6. Support for repeated constellations (config)

The configuration must be capable of representing a reusable structural pattern.

This means:

the constellation represents a pattern that may appear multiple times
the field identity is defined relative to that constellation
no assumption that the constellation appears only once on a page
RUN-TIME MODEL
Run flow (explicit)

Runtime must operate in four stages:

Page-wide structural prepass and candidate constellation selection
Constellation-level structural matching to identify the correct structural frame
Field-level structural reconstruction within the matched constellation
Local visual refine for final precision

Do not invert this order.

1. Page-wide structural prepass (run)

Same as config:

detect regions / containers
detect row bands
detect separators
build structural objects

These must be comparable to config-time structures.

2. Candidate constellation selection (run)

Using page structure:

identify candidate regions/areas that may correspond to the configured constellation
shortlist top candidates
do not assume a single match immediately
3. Constellation-level matching (run)

For each candidate:

match constellation-level structural objects
score partial matches
use object-to-object relationships
allow incomplete matches

Important:

do not require all objects to match
multiple matches = stronger confidence
few matches = weaker but usable

Constellation matching should act as a search scaffold, not just validation.

4. Field reconstruction from structure (run)

After selecting a matched constellation:

estimate the runtime constellation frame
project field geometry into that frame
reconstruct bbox using:
row alignment
separator relationships
slot/value positioning
normalized offsets

If partial matches:

reconstruct using available structure
fall back to normalized bbox priors

The system must reconstruct bbox from incomplete structure.

5. Transformation policy (run)

At runtime:

estimate local scale and translation from matched constellation
project normalized field geometry into runtime coordinates
avoid direct pixel transfer from config

Use hierarchical transforms:

page normalization
constellation-level projection
field-level reconstruction

Use the simplest stable transform necessary.

6. Local visual refine (run)

Use ORB/template/local visual methods only for:

candidate confirmation (optional)
small positional correction
final precision alignment

They must not determine field identity.

7. Support for repeated constellations (run)

Runtime must support multiple matches:

detect multiple constellations matching the same configuration
reconstruct field for each match
extract values from each instance

This should be controlled via search policy, not a separate engine.

8. Diagnostics and visibility

Expose debug information for:

page structural objects
candidate constellations
constellation match scores
selected constellation(s)
field-level constellation
reconstructed bbox before refine
refined bbox after refine
Output required

When complete, provide:

summary of the architectural weakness corrected
list of code changes
how constellation-level identity is stored
how field-level identity is stored
how runtime performs:
candidate selection
constellation matching
bbox reconstruction
how partial matches are handled
how transformation/scaling is handled
how ORB/template refine is used after structural steps
expected improvements for:
different scan qualities
different render scales
correct section but wrong row/slot
repeated structures
partially cropped data
Final goal

Move WFG4 from:

“find the right neighborhood and project a box”

to:

“identify the correct structural constellation, reconstruct the field from structural relationships, then refine locally.”

Data model continuity requirement

This redesign should extend the existing localization/config data model, not replace it.

The current field-level localization model and geometry contract should remain the authoritative base representation used by the rest of the pipeline.

The task here is to add richer structural metadata to that existing per-field model, including page-level context, constellation-level identity, field-level structural relationships, and normalized reconstruction data.

Do not:

redesign the overall field contract unnecessarily
create a separate competing localization representation
break downstream assumptions about how configured fields/geometries are stored and consumed

In other words, this work should be an augmentation of the current per-field localization model, not a wholesale model replacement.

Example mental model / intended flow

This is not a separate redesign request. It is a concrete example of the intended behavior.

Config example
User creates a wizard / extraction configuration.
User uploads a representative document or image during config.
WFG4 performs the config-time page-wide structural prepass:
detect major regions / containers
detect row bands
detect separators and nearby structural objects
The user draws a bbox for the desired field.
That user-drawn bbox is the field target.
WFG4 then determines the constellation the field belongs to and builds:
page-level context
constellation-level structural identity
field-level structural identity
The system stores the field not just as raw bbox pixels, but as:
bbox geometry normalized to the constellation
row / slot relationships where possible
nearby structural objects
object-to-object and object-to-bbox relationships
This saved config should represent a reusable structural pattern, not just a one-off pixel location.
Run example
At run time, a new document or image is uploaded.
WFG4 performs the same page-wide structural prepass on the run document.
WFG4 identifies candidate constellations that may correspond to the config-time constellation.
WFG4 matches the run-time structure against the saved constellation structure.
From the best full or partial structural match, WFG4 reconstructs the field bbox in run-time coordinates.
WFG4 then applies local visual refine only after the structural reconstruction step.
Final extraction should come from the structurally reconstructed and locally refined field target, not from raw bbox transfer or neighborhood projection alone.
Intended outcome

The goal is that the system understands:

what structural pattern the field belongs to
where the field should exist inside that pattern
how to reconstruct it under scale/render/layout variation
how to support repeated matching constellations later if needed
