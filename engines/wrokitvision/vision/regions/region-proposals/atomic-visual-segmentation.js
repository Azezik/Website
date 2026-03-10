'use strict';

function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function resolveRgbChannels(imageData, expectedLength){
  if(!imageData || expectedLength <= 0) return null;
  const r = imageData.r;
  const g = imageData.g;
  const b = imageData.b;
  if(r?.length === expectedLength && g?.length === expectedLength && b?.length === expectedLength){
    return { r, g, b };
  }
  const rgba = imageData.rgba || imageData.data;
  if(!rgba || rgba.length < expectedLength * 4) return null;
  const rr = new Uint8Array(expectedLength);
  const gg = new Uint8Array(expectedLength);
  const bb = new Uint8Array(expectedLength);
  for(let i = 0, j = 0; i < expectedLength; i++, j += 4){
    rr[i] = rgba[j] || 0;
    gg[i] = rgba[j + 1] || 0;
    bb[i] = rgba[j + 2] || 0;
  }
  return { r: rr, g: gg, b: bb };
}

function sobelStrength(gray, width, height){
  const out = new Uint16Array(width * height);
  for(let y = 1; y < height - 1; y++){
    for(let x = 1; x < width - 1; x++){
      const i = y * width + x;
      const gx = -gray[i-width-1] - 2 * gray[i-1] - gray[i+width-1]
               + gray[i-width+1] + 2 * gray[i+1] + gray[i+width+1];
      const gy = -gray[i-width-1] - 2 * gray[i-width] - gray[i-width+1]
               + gray[i+width-1] + 2 * gray[i+width] + gray[i+width+1];
      out[i] = Math.min(1020, Math.round(Math.sqrt((gx * gx) + (gy * gy))));
    }
  }
  return out;
}

function localVariance(gray, width, height){
  const variance = new Uint16Array(width * height);
  for(let y = 1; y < height - 1; y++){
    for(let x = 1; x < width - 1; x++){
      const i = y * width + x;
      let sum = 0;
      let sumSq = 0;
      for(let oy = -1; oy <= 1; oy++){
        for(let ox = -1; ox <= 1; ox++){
          const v = gray[(y + oy) * width + (x + ox)];
          sum += v;
          sumSq += v * v;
        }
      }
      const mean = sum / 9;
      const varVal = (sumSq / 9) - (mean * mean);
      variance[i] = clamp(Math.round(Math.sqrt(Math.max(0, varVal)) * 4), 0, 255);
    }
  }
  return variance;
}

function colorGradient(rgb, width, height){
  if(!rgb) return null;
  const out = new Uint16Array(width * height);
  for(let y = 1; y < height - 1; y++){
    for(let x = 1; x < width - 1; x++){
      const i = y * width + x;
      // Sobel on each channel, take max magnitude across R/G/B.
      // This gives a strong response at color-only boundaries even when
      // luminance is nearly identical across the edge.
      let maxGrad = 0;
      const channels = [rgb.r, rgb.g, rgb.b];
      for(const ch of channels){
        const gx = -ch[i-width-1] - 2*ch[i-1] - ch[i+width-1]
                   + ch[i-width+1] + 2*ch[i+1] + ch[i+width+1];
        const gy = -ch[i-width-1] - 2*ch[i-width] - ch[i-width+1]
                   + ch[i+width-1] + 2*ch[i+width] + ch[i+width+1];
        const grad = Math.sqrt((gx * gx) + (gy * gy));
        if(grad > maxGrad) maxGrad = grad;
      }
      out[i] = Math.min(1020, Math.round(maxGrad));
    }
  }
  return out;
}

function buildBoundaryEvidence({ gray, rgb, width, height }){
  const edge = sobelStrength(gray, width, height);
  const variance = localVariance(gray, width, height);
  const color = colorGradient(rgb, width, height);
  const evidence = new Uint8Array(width * height);
  for(let i = 0; i < evidence.length; i++){
    const edgeNorm = edge[i] / 1020;
    const colorNorm = color ? color[i] / 1020 : 0;
    const varNorm = variance[i] / 255;
    // Rebalanced weights: raised variance from 0.14→0.20 so edge-dominant
    // scenes (low color gradient) still produce meaningful boundary evidence
    // via local texture contrast.  Edge and color weights reduced proportionally.
    evidence[i] = clamp(Math.round((edgeNorm * 0.41 + colorNorm * 0.39 + varNorm * 0.20) * 255), 0, 255);
  }
  return evidence;
}

function chooseAtomicSeeds(boundaryEvidence, width, height){
  const seeds = [];
  const stride = clamp(Math.round(Math.sqrt((width * height) / 3200)), 4, 9);
  for(let sy = 0; sy < height; sy += stride){
    for(let sx = 0; sx < width; sx += stride){
      let bestIdx = (sy * width) + sx;
      let bestScore = 999;
      const yMax = Math.min(height, sy + stride);
      const xMax = Math.min(width, sx + stride);
      for(let y = sy; y < yMax; y++){
        for(let x = sx; x < xMax; x++){
          const idx = (y * width) + x;
          const score = boundaryEvidence[idx];
          if(score < bestScore){
            bestScore = score;
            bestIdx = idx;
          }
        }
      }
      seeds.push(bestIdx);
    }
  }
  return Array.from(new Set(seeds));
}

function buildAtomicRegions({ gray, rgb, width, height }){
  const boundaryEvidence = buildBoundaryEvidence({ gray, rgb, width, height });
  const labels = new Int32Array(width * height);
  labels.fill(-1);

  const seeds = chooseAtomicSeeds(boundaryEvidence, width, height);
  const buckets = Array.from({ length: 256 }, () => []);
  for(let regionId = 0; regionId < seeds.length; regionId++){
    const idx = seeds[regionId];
    labels[idx] = regionId;
    buckets[boundaryEvidence[idx]].push(idx);
  }

  // Hard barrier controls the maximum boundary evidence a region can grow across.
  // Previously 206 (~81%), then 155 (~61%), then 165 (~65%).  Raised to 170 (~67%)
  // based on Session A annotation evidence (6 files, avgAutoRegionCount 43.3 vs
  // avgHumanRegionCount 11): persistent over-segmentation indicates regions are
  // still atomising at too-low a boundary evidence level.  The conservative +5
  // increase lets growth absorb low-contrast internal texture (subtle gradients,
  // lightly anti-aliased strokes) while still halting at genuine structural edges.
  // Session B (contract, IoU 0.77) remains unaffected at this magnitude.
  const hardBarrier = 170;
  for(let score = 0; score < buckets.length; score++){
    const queue = buckets[score];
    for(let qi = 0; qi < queue.length; qi++){
      const idx = queue[qi];
      const rid = labels[idx];
      if(rid < 0) continue;
      const x = idx % width;
      const y = (idx / width) | 0;
      const nbrs = [idx - 1, idx + 1, idx - width, idx + width];
      for(const ni of nbrs){
        const nx = ni % width;
        const ny = (ni / width) | 0;
        if(nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if(Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if(labels[ni] !== -1) continue;
        const link = Math.max(boundaryEvidence[idx], boundaryEvidence[ni]);
        if(link >= hardBarrier) continue;
        labels[ni] = rid;
        buckets[link].push(ni);
      }
    }
  }

  // Assign leftovers to nearest labeled neighbor (keeps partition total).
  for(let i = 0; i < labels.length; i++){
    if(labels[i] !== -1) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const nbrs = [i - 1, i + 1, i - width, i + width];
    let assigned = -1;
    for(const ni of nbrs){
      const nx = ni % width;
      const ny = (ni / width) | 0;
      if(nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if(Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
      if(labels[ni] >= 0){ assigned = labels[ni]; break; }
    }
    labels[i] = assigned >= 0 ? assigned : 0;
  }

  const regions = [];
  for(let i = 0; i < seeds.length; i++){
    regions.push({ id: i, area: 0, sumGray: 0, sumR: 0, sumG: 0, sumB: 0, x0: width, y0: height, x1: 0, y1: 0 });
  }
  for(let i = 0; i < labels.length; i++){
    const rid = labels[i];
    const x = i % width;
    const y = (i / width) | 0;
    const r = regions[rid];
    r.area += 1;
    r.sumGray += gray[i];
    r.sumR += rgb ? rgb.r[i] : gray[i];
    r.sumG += rgb ? rgb.g[i] : gray[i];
    r.sumB += rgb ? rgb.b[i] : gray[i];
    if(x < r.x0) r.x0 = x;
    if(y < r.y0) r.y0 = y;
    if(x > r.x1) r.x1 = x;
    if(y > r.y1) r.y1 = y;
  }
  return { labels, regions, boundaryEvidence };
}

/**
 * Extract a simplified boundary contour for a merged region from the label map.
 * Uses border-tracing: collects all pixels on the region boundary (those adjacent
 * to a pixel of a different region or the image edge), then reduces the point set
 * to a simplified polygon via angular sampling from the centroid.
 */
function extractRegionContour(labels, mergedRootIds, width, height, sx, sy){
  const idSet = new Set(mergedRootIds);
  const borderPixels = [];
  const x0 = Math.max(0, Math.floor(mergedRootIds._x0 || 0));
  const y0 = Math.max(0, Math.floor(mergedRootIds._y0 || 0));
  const x1 = Math.min(width - 1, Math.ceil(mergedRootIds._x1 || width - 1));
  const y1 = Math.min(height - 1, Math.ceil(mergedRootIds._y1 || height - 1));

  for(let y = y0; y <= y1; y++){
    for(let x = x0; x <= x1; x++){
      const idx = y * width + x;
      if(!idSet.has(labels[idx])) continue;
      // Check if on region boundary
      let isBorder = false;
      if(x === 0 || x === width - 1 || y === 0 || y === height - 1){
        isBorder = true;
      } else {
        const nbrs = [idx - 1, idx + 1, idx - width, idx + width];
        for(const ni of nbrs){
          if(!idSet.has(labels[ni])){ isBorder = true; break; }
        }
      }
      if(isBorder) borderPixels.push({ x: x * sx, y: y * sy });
    }
  }

  if(borderPixels.length < 3) return null;

  // Simplify: sample boundary by angular bins from centroid
  let cx = 0, cy = 0;
  for(const p of borderPixels){ cx += p.x; cy += p.y; }
  cx /= borderPixels.length;
  cy /= borderPixels.length;

  const NUM_BINS = 36;
  const bins = new Array(NUM_BINS).fill(null);
  for(const p of borderPixels){
    const angle = Math.atan2(p.y - cy, p.x - cx);
    const bin = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * NUM_BINS) % NUM_BINS;
    const dist = Math.hypot(p.x - cx, p.y - cy);
    if(!bins[bin] || dist > bins[bin].dist){
      bins[bin] = { x: p.x, y: p.y, dist };
    }
  }

  const contour = bins.filter(Boolean).map(b => ({ x: b.x, y: b.y }));
  return contour.length >= 3 ? contour : null;
}

function mergeAtomicRegions({ labels, regions, boundaryEvidence, width, height }){
  const adjacency = new Map();
  const keyOf = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  for(let y = 0; y < height; y++){
    for(let x = 0; x < width; x++){
      const idx = y * width + x;
      const a = labels[idx];
      if(x + 1 < width){
        const b = labels[idx + 1];
        if(a !== b){
          const k = keyOf(a, b);
          const rec = adjacency.get(k) || { a: Math.min(a, b), b: Math.max(a, b), border: 0, edge: 0 };
          rec.border += 1;
          rec.edge += Math.max(boundaryEvidence[idx], boundaryEvidence[idx + 1]);
          adjacency.set(k, rec);
        }
      }
      if(y + 1 < height){
        const b = labels[idx + width];
        if(a !== b){
          const k = keyOf(a, b);
          const rec = adjacency.get(k) || { a: Math.min(a, b), b: Math.max(a, b), border: 0, edge: 0 };
          rec.border += 1;
          rec.edge += Math.max(boundaryEvidence[idx], boundaryEvidence[idx + width]);
          adjacency.set(k, rec);
        }
      }
    }
  }

  const parent = Int32Array.from({ length: regions.length }, (_, i) => i);
  const find = (x) => {
    while(parent[x] !== x){ parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if(ra !== rb) parent[rb] = ra;
  };

  for(const rec of adjacency.values()){
    const ra = regions[rec.a];
    const rb = regions[rec.b];
    if(!ra || !rb || !ra.area || !rb.area) continue;
    const edgeMean = rec.edge / Math.max(1, rec.border);
    const grayDelta = Math.abs((ra.sumGray / ra.area) - (rb.sumGray / rb.area));
    const colorDelta = Math.hypot(
      (ra.sumR / ra.area) - (rb.sumR / rb.area),
      (ra.sumG / ra.area) - (rb.sumG / rb.area),
      (ra.sumB / ra.area) - (rb.sumB / rb.area)
    );

    // Border-length gate: require shared border to be proportional to the
    // smaller region's perimeter.  This prevents merging regions that only
    // touch at a thin seam (e.g. adjacent high-contrast shapes).
    const smallerArea = Math.min(ra.area, rb.area);
    const approxPerimeter = 4 * Math.sqrt(smallerArea);
    const borderRatio = rec.border / Math.max(1, approxPerimeter);

    // If shared border is less than 8% of estimated perimeter, require
    // much stricter color similarity to merge (halve the threshold).
    const borderPenalty = borderRatio < 0.08 ? 0.5 : 1.0;

    // Aspect-ratio divergence penalty: when two regions have very different
    // aspect ratios, they likely belong to different layout rows/columns.
    // This prevents horizontal text strips from merging with adjacent rows.
    const arA = (ra.x1 - ra.x0 + 1) / Math.max(1, ra.y1 - ra.y0 + 1);
    const arB = (rb.x1 - rb.x0 + 1) / Math.max(1, rb.y1 - rb.y0 + 1);
    const arDivergence = Math.max(arA, arB) / Math.max(0.01, Math.min(arA, arB));
    // Penalize when aspect ratios diverge by more than 3:1
    const arPenalty = arDivergence > 3.0 ? 1.3 : 1.0;

    // Color-dominant merge scoring with border-length and aspect-ratio gates.
    // Learning-session recommendation (lsess-mmkv51e3-rmyd-1) indicates
    // sustained over-segmentation, so this merge threshold is raised to 64.
    const mergeScore = ((edgeMean * 0.25) + (grayDelta * 0.15) + (colorDelta * 0.60)) * arPenalty;
    if(mergeScore <= 64 * borderPenalty) union(rec.a, rec.b);
  }

  const merged = new Map();
  for(let rid = 0; rid < regions.length; rid++){
    const region = regions[rid];
    if(!region.area) continue;
    const root = find(rid);
    const agg = merged.get(root) || { area: 0, x0: width, y0: height, x1: 0, y1: 0, atomicCount: 0, rootIds: [] };
    agg.area += region.area;
    agg.atomicCount += 1;
    agg.rootIds.push(rid);
    if(region.x0 < agg.x0) agg.x0 = region.x0;
    if(region.y0 < agg.y0) agg.y0 = region.y0;
    if(region.x1 > agg.x1) agg.x1 = region.x1;
    if(region.y1 > agg.y1) agg.y1 = region.y1;
    merged.set(root, agg);
  }

  return { mergedRegions: Array.from(merged.values()), parent, find };
}

function buildAtomicVisualSegments({ imageData }){
  if(!imageData?.gray || !imageData.width || !imageData.height) return null;
  const width = Number(imageData.width) || 0;
  const height = Number(imageData.height) || 0;
  if(width <= 2 || height <= 2) return null;
  const gray = imageData.gray;
  const rgb = resolveRgbChannels(imageData, gray.length);
  const atomic = buildAtomicRegions({ gray, rgb, width, height });
  const mergeResult = mergeAtomicRegions({ ...atomic, width, height });
  return {
    width,
    height,
    atomicCount: atomic.regions.length,
    mergedRegions: mergeResult.mergedRegions,
    labels: atomic.labels,
    parent: mergeResult.parent,
    find: mergeResult.find
  };
}

module.exports = {
  buildAtomicVisualSegments,
  extractRegionContour
};
