'use strict';

const { ensureBBox } = require('../../types');

// ─── Geometry helpers ───────────────────────────────────────────────

function bboxArea(b) { return b.w * b.h; }

function bboxIntersection(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function iou(a, b) {
  const inter = bboxIntersection(a, b);
  if (!inter) return 0;
  const interArea = bboxArea(inter);
  return interArea / (bboxArea(a) + bboxArea(b) - interArea);
}

function overlapFraction(a, b) {
  const inter = bboxIntersection(a, b);
  if (!inter) return 0;
  return bboxArea(inter) / Math.max(1, Math.min(bboxArea(a), bboxArea(b)));
}

function fullyContains(outer, inner) {
  return outer.x <= inner.x &&
    outer.y <= inner.y &&
    (outer.x + outer.w) >= (inner.x + inner.w) &&
    (outer.y + outer.h) >= (inner.y + inner.h);
}

function gapBetween(a, b) {
  const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(gapX, gapY);
}

function sharesEdge(a, b, tolerance) {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapX <= 0 && overlapY <= 0) return null;

  // Horizontal adjacency: vertically overlapping, horizontally abutting
  if (overlapY > tolerance) {
    const rightEdgeA = a.x + a.w;
    const rightEdgeB = b.x + b.w;
    if (Math.abs(rightEdgeA - b.x) <= tolerance) return { axis: 'horizontal', sharedLength: overlapY };
    if (Math.abs(rightEdgeB - a.x) <= tolerance) return { axis: 'horizontal', sharedLength: overlapY };
  }
  // Vertical adjacency: horizontally overlapping, vertically abutting
  if (overlapX > tolerance) {
    const bottomEdgeA = a.y + a.h;
    const bottomEdgeB = b.y + b.h;
    if (Math.abs(bottomEdgeA - b.y) <= tolerance) return { axis: 'vertical', sharedLength: overlapX };
    if (Math.abs(bottomEdgeB - a.y) <= tolerance) return { axis: 'vertical', sharedLength: overlapX };
  }
  return null;
}

function rectContourFromBbox(bbox) {
  const x = Number(bbox.x) || 0;
  const y = Number(bbox.y) || 0;
  const w = Math.max(0, Number(bbox.w) || 0);
  const h = Math.max(0, Number(bbox.h) || 0);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h }
  ];
}

// ─── 1. Containment hierarchy detection ─────────────────────────────

function classifyContainmentLayers(regions) {
  const boxes = regions.map(r => ensureBBox(r.geometry?.bbox || {}));
  const n = regions.length;
  const containedBy = new Array(n).fill(-1); // index of smallest container
  const depth = new Array(n).fill(0);

  // Sort by area descending so larger regions are checked first as containers
  const byArea = regions.map((_, i) => i).sort((a, b) => bboxArea(boxes[b]) - bboxArea(boxes[a]));

  for (let pi = 0; pi < byArea.length; pi++) {
    const i = byArea[pi];
    for (let pj = pi + 1; pj < byArea.length; pj++) {
      const j = byArea[pj];
      if (fullyContains(boxes[i], boxes[j])) {
        // j is contained by i; only assign if i is smaller than current container
        if (containedBy[j] === -1 || bboxArea(boxes[i]) < bboxArea(boxes[containedBy[j]])) {
          containedBy[j] = i;
        }
      }
    }
  }

  // Compute depth from containment chain
  function getDepth(i) {
    if (depth[i] > 0) return depth[i];
    if (containedBy[i] === -1) return 0;
    depth[i] = getDepth(containedBy[i]) + 1;
    return depth[i];
  }
  for (let i = 0; i < n; i++) getDepth(i);

  return { containedBy, depth };
}

// ─── 2. Same-layer overlap resolution ───────────────────────────────

function resolveOverlaps(regions, containedBy) {
  const boxes = regions.map(r => ensureBBox(r.geometry?.bbox || {}));
  const n = regions.length;
  const removed = new Set();

  for (let i = 0; i < n; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < n; j++) {
      if (removed.has(j)) continue;

      // Skip pairs that are in a true parent-child containment relationship.
      // But if the contained region is > 80% of the container's area, they are
      // near-duplicates, not genuine containment — let the overlap logic handle them.
      if (containedBy[j] === i || containedBy[i] === j) {
        const containerIdx = containedBy[j] === i ? i : j;
        const containedIdx = containedBy[j] === i ? j : i;
        const areaRatio = bboxArea(boxes[containedIdx]) / Math.max(1, bboxArea(boxes[containerIdx]));
        if (areaRatio < 0.80) continue;
      }

      const ofrac = overlapFraction(boxes[i], boxes[j]);
      if (ofrac < 0.3) continue; // tolerate minor overlap

      const iouVal = iou(boxes[i], boxes[j]);

      // High IOU → near duplicates. Keep the one with higher confidence or
      // more specific provenance.
      if (iouVal > 0.7) {
        const keepI = scoreRegionForRetention(regions[i]);
        const keepJ = scoreRegionForRetention(regions[j]);
        if (keepI >= keepJ) {
          removed.add(j);
        } else {
          removed.add(i);
          break;
        }
        continue;
      }

      // Moderate overlap between same-layer peers → trim the larger region's
      // boundary so it stops at the smaller region's edge.
      if (ofrac >= 0.3 && ofrac < 0.85) {
        const areaI = bboxArea(boxes[i]);
        const areaJ = bboxArea(boxes[j]);
        const largerIdx = areaI >= areaJ ? i : j;
        const smallerIdx = areaI >= areaJ ? j : i;

        // Only trim if they share the same parent (same structural layer)
        if (containedBy[largerIdx] === containedBy[smallerIdx]) {
          trimOverlappingBoundary(boxes, largerIdx, smallerIdx);
          applyBboxToRegion(regions[largerIdx], boxes[largerIdx]);
        }
      }
    }
  }

  return regions.filter((_, i) => !removed.has(i));
}

function scoreRegionForRetention(region) {
  let score = Number(region.confidence) || 0;
  // Prefer OCR-sourced regions
  if (region.provenance?.sourceType === 'ocr') score += 0.3;
  // Prefer regions with real contours
  if (region.features?.hasRealContour) score += 0.1;
  // Prefer regions with text content
  if (region.textDensity > 0.5) score += 0.2;
  return score;
}

function trimOverlappingBoundary(boxes, largerIdx, smallerIdx) {
  const lg = boxes[largerIdx];
  const sm = boxes[smallerIdx];

  const inter = bboxIntersection(lg, sm);
  if (!inter) return;

  // Determine which edge of the larger box to trim based on overlap geometry.
  // Find the direction where trimming removes the least area.
  const trimLeft = inter.x === lg.x ? inter.w : 0;
  const trimRight = (inter.x + inter.w === lg.x + lg.w) ? inter.w : 0;
  const trimTop = inter.y === lg.y ? inter.h : 0;
  const trimBottom = (inter.y + inter.h === lg.y + lg.h) ? inter.h : 0;

  const trims = [
    { side: 'left', amount: trimLeft },
    { side: 'right', amount: trimRight },
    { side: 'top', amount: trimTop },
    { side: 'bottom', amount: trimBottom }
  ].filter(t => t.amount > 0);

  if (trims.length === 0) return;

  // Pick the trim that removes the least area
  trims.sort((a, b) => a.amount - b.amount);
  const best = trims[0];

  switch (best.side) {
    case 'left':
      lg.w -= best.amount;
      lg.x += best.amount;
      break;
    case 'right':
      lg.w -= best.amount;
      break;
    case 'top':
      lg.h -= best.amount;
      lg.y += best.amount;
      break;
    case 'bottom':
      lg.h -= best.amount;
      break;
  }
}

function applyBboxToRegion(region, bbox) {
  region.geometry.bbox = { ...bbox };
  region.geometry.contour = rectContourFromBbox(bbox);
  region.geometry.polygon = rectContourFromBbox(bbox);
  if (region.geometry.hull) {
    region.geometry.hull = rectContourFromBbox(bbox);
  }
  if (region.geometry.rotatedRect) {
    region.geometry.rotatedRect = {
      center: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 },
      size: { w: bbox.w, h: bbox.h },
      angleDeg: region.geometry.rotatedRect.angleDeg || 0
    };
  }
}

// ─── 3. Edge-aligned boundary snapping ──────────────────────────────

function snapBoundariesToEdges(regions, tolerance) {
  if (!tolerance) tolerance = 6;
  const boxes = regions.map(r => ensureBBox(r.geometry?.bbox || {}));
  const n = regions.length;

  // Collect all strong edges (region boundaries) as candidate snap lines
  const hLines = []; // horizontal lines (y-values)
  const vLines = []; // vertical lines (x-values)

  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    hLines.push(b.y, b.y + b.h);
    vLines.push(b.x, b.x + b.w);
  }

  // Cluster nearby edge lines
  const hClusters = clusterValues(hLines, tolerance);
  const vClusters = clusterValues(vLines, tolerance);

  // Snap each region boundary to the nearest cluster center
  let changed = false;
  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    const origX = b.x, origY = b.y, origR = b.x + b.w, origB = b.y + b.h;

    const snappedTop = snapToCluster(b.y, hClusters, tolerance);
    const snappedBottom = snapToCluster(b.y + b.h, hClusters, tolerance);
    const snappedLeft = snapToCluster(b.x, vClusters, tolerance);
    const snappedRight = snapToCluster(b.x + b.w, vClusters, tolerance);

    const newX = snappedLeft;
    const newY = snappedTop;
    const newW = Math.max(2, snappedRight - snappedLeft);
    const newH = Math.max(2, snappedBottom - snappedTop);

    if (newX !== origX || newY !== origY ||
      newW !== (origR - origX) || newH !== (origB - origY)) {
      boxes[i] = { x: newX, y: newY, w: newW, h: newH };
      applyBboxToRegion(regions[i], boxes[i]);
      changed = true;
    }
  }

  return changed;
}

function clusterValues(values, tolerance) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  let clusterStart = 0;

  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] - sorted[i - 1] > tolerance) {
      // Compute cluster center as mean
      let sum = 0;
      let count = 0;
      for (let j = clusterStart; j < i; j++) {
        sum += sorted[j];
        count++;
      }
      clusters.push({ center: sum / count, count });
      clusterStart = i;
    }
  }

  return clusters;
}

function snapToCluster(value, clusters, tolerance) {
  let bestDist = tolerance + 1;
  let bestCenter = value;

  for (const c of clusters) {
    const dist = Math.abs(value - c.center);
    if (dist < bestDist) {
      bestDist = dist;
      bestCenter = c.center;
    }
  }

  return bestDist <= tolerance ? Math.round(bestCenter * 100) / 100 : value;
}

// ─── 4. Repeating structure detection & dimension normalization ─────

function normalizeRepeatingStructures(regions) {
  const boxes = regions.map(r => ensureBBox(r.geometry?.bbox || {}));
  const n = regions.length;
  if (n < 3) return;

  // Detect horizontal runs (regions aligned along Y-axis, sequential in X)
  const hGroups = detectAlignedGroups(boxes, 'horizontal');
  // Detect vertical runs (regions aligned along X-axis, sequential in Y)
  const vGroups = detectAlignedGroups(boxes, 'vertical');

  for (const group of [...hGroups, ...vGroups]) {
    if (group.indices.length < 3) continue;
    normalizeGroupDimensions(regions, boxes, group);
  }
}

function detectAlignedGroups(boxes, axis) {
  const n = boxes.length;
  const groups = [];
  const tolerance = 8;

  // Sort indices by position on the primary axis
  const indices = boxes.map((_, i) => i);

  if (axis === 'horizontal') {
    // Group by similar Y-center, sorted by X
    indices.sort((a, b) => {
      const ya = boxes[a].y + boxes[a].h / 2;
      const yb = boxes[b].y + boxes[b].h / 2;
      return ya - yb;
    });

    let groupStart = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i === indices.length ||
        Math.abs((boxes[indices[i]].y + boxes[indices[i]].h / 2) -
          (boxes[indices[i - 1]].y + boxes[indices[i - 1]].h / 2)) > tolerance) {
        if (i - groupStart >= 3) {
          const groupIndices = indices.slice(groupStart, i);
          groupIndices.sort((a, b) => boxes[a].x - boxes[b].x);

          // Check if heights are similar (within 30%)
          const heights = groupIndices.map(idx => boxes[idx].h);
          const medianH = median(heights);
          const consistent = heights.every(h => Math.abs(h - medianH) / Math.max(1, medianH) < 0.3);

          if (consistent) {
            // For horizontal runs, normalize heights (cross-axis) and widths (along-axis)
            const widths = groupIndices.map(idx => boxes[idx].w);
            const medianW = median(widths);
            const wConsistent = widths.every(w => Math.abs(w - medianW) / Math.max(1, medianW) < 0.3);
            groups.push({ axis, indices: groupIndices, medianSize: medianH, sizeKey: 'h' });
            if (wConsistent) {
              groups.push({ axis, indices: groupIndices, medianSize: medianW, sizeKey: 'w' });
            }
          }
        }
        groupStart = i;
      }
    }
  } else {
    // Group by similar X-center, sorted by Y
    indices.sort((a, b) => {
      const xa = boxes[a].x + boxes[a].w / 2;
      const xb = boxes[b].x + boxes[b].w / 2;
      return xa - xb;
    });

    let groupStart = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i === indices.length ||
        Math.abs((boxes[indices[i]].x + boxes[indices[i]].w / 2) -
          (boxes[indices[i - 1]].x + boxes[indices[i - 1]].w / 2)) > tolerance) {
        if (i - groupStart >= 3) {
          const groupIndices = indices.slice(groupStart, i);
          groupIndices.sort((a, b) => boxes[a].y - boxes[b].y);

          const widths = groupIndices.map(idx => boxes[idx].w);
          const medianW = median(widths);
          const consistent = widths.every(w => Math.abs(w - medianW) / Math.max(1, medianW) < 0.3);

          if (consistent) {
            groups.push({ axis, indices: groupIndices, medianSize: medianW, sizeKey: 'w' });
            // For vertical runs, also normalize heights (along-axis)
            const heights = groupIndices.map(idx => boxes[idx].h);
            const medianH = median(heights);
            const hConsistent = heights.every(h => Math.abs(h - medianH) / Math.max(1, medianH) < 0.3);
            if (hConsistent) {
              groups.push({ axis, indices: groupIndices, medianSize: medianH, sizeKey: 'h' });
            }
          }
        }
        groupStart = i;
      }
    }
  }

  return groups;
}

function normalizeGroupDimensions(regions, boxes, group) {
  const { indices, medianSize, sizeKey, axis } = group;

  // Normalize the cross-axis dimension to the median
  for (const idx of indices) {
    const b = boxes[idx];
    const currentSize = b[sizeKey];
    const delta = Math.abs(currentSize - medianSize);

    // Only normalize if the difference is small (< 20% of median) — soft heuristic
    if (delta / Math.max(1, medianSize) < 0.20 && delta > 0.5) {
      const center = sizeKey === 'h'
        ? b.y + b.h / 2
        : b.x + b.w / 2;

      if (sizeKey === 'h') {
        b.h = medianSize;
        b.y = center - medianSize / 2;
      } else {
        b.w = medianSize;
        b.x = center - medianSize / 2;
      }

      applyBboxToRegion(regions[idx], b);
    }
  }

  // Snap sequential boundaries: if gap between consecutive regions is small,
  // close it so they tile
  for (let i = 1; i < indices.length; i++) {
    const prev = boxes[indices[i - 1]];
    const curr = boxes[indices[i]];

    if (axis === 'horizontal') {
      const gapX = curr.x - (prev.x + prev.w);
      if (gapX > 0 && gapX < 8) {
        // Close the gap by splitting the difference
        const mid = prev.x + prev.w + gapX / 2;
        prev.w = mid - prev.x;
        const newX = mid;
        curr.w = (curr.x + curr.w) - newX;
        curr.x = newX;
        applyBboxToRegion(regions[indices[i - 1]], prev);
        applyBboxToRegion(regions[indices[i]], curr);
      }
    } else {
      const gapY = curr.y - (prev.y + prev.h);
      if (gapY > 0 && gapY < 8) {
        const mid = prev.y + prev.h + gapY / 2;
        prev.h = mid - prev.y;
        const newY = mid;
        curr.h = (curr.y + curr.h) - newY;
        curr.y = newY;
        applyBboxToRegion(regions[indices[i - 1]], prev);
        applyBboxToRegion(regions[indices[i]], curr);
      }
    }
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── 5. Main refinement pipeline ────────────────────────────────────

function refineRegionCoherence(regions) {
  if (!Array.isArray(regions) || regions.length < 2) return regions;

  // Step 1: Build containment hierarchy
  const { containedBy, depth } = classifyContainmentLayers(regions);

  // Annotate each region with its layer depth and parent index
  for (let i = 0; i < regions.length; i++) {
    regions[i].features = regions[i].features || {};
    regions[i].features.containmentDepth = depth[i];
    regions[i].features.containmentParentIdx = containedBy[i];
  }

  // Step 2: Resolve same-layer overlaps (deduplicate, trim)
  const refined = resolveOverlaps(regions, containedBy);

  // Step 3: Snap boundaries to strong edge lines
  snapBoundariesToEdges(refined, 6);

  // Step 4: Detect repeating structures and normalize dimensions
  normalizeRepeatingStructures(refined);

  // Step 5: Second pass of edge snapping after normalization
  snapBoundariesToEdges(refined, 4);

  return refined;
}

module.exports = {
  refineRegionCoherence
};
