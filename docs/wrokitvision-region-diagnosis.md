# WrokitVision region-generation diagnosis (current behavior)

## Scope
This note audits the **current** region proposal behavior and explains why region overlays collapse into very large components.

## What the code is currently doing

### 1) Visual regions are built from grayscale-only luminance
The debug map path explicitly converts page pixels to grayscale and passes only `{ gray, width, height }` into map building.

- `invoice-wizard.js` notes that map building currently consumes grayscale only.
- `ensureGrayCanvas` collapses RGB into a single luminance channel before extraction.

### 2) Primary visual segmentation is coarse luminance connected-components
`buildVisualRegionLayer`:

- downsamples into a fixed **64x48** grid,
- computes mean luminance per cell,
- merges 4-neighbor cells when luminance delta is <= `TOLERANCE` (30),
- keeps connected components above a 2% cell-area floor,
- emits one rotated rectangle per component.

This is effectively *surface clustering*, not object-boundary segmentation.

### 3) Edge detection exists, but is not used as a barrier for visual-region growth
Sobel edges are computed and used for structural line finding (for panel-style layout cells), not to stop visual region union.

So a strong edge between two adjacent cells does **not** prevent them from being merged in `buildVisualRegionLayer`.

### 4) A second visual detector also uses thresholded connected components
In the typed upload-analysis pipeline, `detectConnectedVisualProposals`:

- thresholds grayscale globally (`gray <= mean * 0.82`),
- flood-fills connected foreground pixels,
- emits contour/hull/rotatedRect for each component.

No edge barrier is consulted during flood-fill. If thresholding links objects via background/shadow/anti-aliased bridges, they become one component.

## Why large merged regions happen
1. **Grayscale collapse removes chroma contrast** between differently colored shapes that can have similar luminance.
2. **Connectivity rule is permissive** (`|Δluminance| <= 30` on coarse cells), so slow gradients and low-contrast transitions chain across wide areas.
3. **No explicit boundary-stop rule** in either union-find growth or flood-fill expansion.
4. **Geometry fitting (convex hull + PCA/rotated rect)** describes the merged blob after the fact; it does not split it.

Net effect: the system often models an entire page surface/document/tabletop as a single connected region, and the green loop/rotated box trace that aggregate boundary.

## Why the synthetic circle/triangle/pentagon image fails
- The background and shape fills are pastel with soft gradients/shadows; many adjacent cells stay within the 30-luminance tolerance.
- At 64x48 resolution, anti-aliased boundaries are averaged into cells, weakening local contrast.
- Union-find chains through intermediate cells, producing one dominant component that spans most of the canvas.
- The rendered contour/rotated rectangle therefore wraps the full merged mass instead of individual shapes.

## What segmentation currently relies on
- **Connected components:** yes (primary mechanism in both map layer and typed visual proposals).
- **Gradient thresholding:** yes, but only for structural line extraction, not visual region splitting.
- **Variance maps:** no.
- **Edge detection:** present, but used for panel/line heuristics rather than region-growth barriers.

## Minimal correction (no architecture rewrite)
Add a **hard edge barrier in adjacency/expansion tests**:

- In `buildVisualRegionLayer`, before `union(i, j)`, sample the Sobel edge map along the shared border between the two cells.
- If edge density on that border exceeds a small threshold, **do not union** even when luminance difference passes tolerance.

Equivalent minimal variant for typed flood-fill path:
- During BFS neighbor expansion in `detectConnectedVisualProposals`, block traversal across a pixel neighbor when local edge magnitude is strong.

This single rule adds missing boundary awareness while preserving the current connected-component architecture, data model, and downstream region consumers.
