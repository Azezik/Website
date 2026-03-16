'use strict';

const { ensureBBox } = require('../../types');

function overlapRatio(a, b){
  const ax1 = a.x + a.w;
  const ay1 = a.y + a.h;
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  const ox = Math.max(0, Math.min(ax1, bx1) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(ay1, by1) - Math.max(a.y, b.y));
  const overlap = ox * oy;
  const area = Math.max(1, a.w * a.h);
  return overlap / area;
}

function computeRegionFeatures(regionNodes = [], textTokens = []){
  // First pass: compute per-region features including shape descriptors
  const enriched = regionNodes.map(region => {
    const box = ensureBBox(region.geometry?.bbox || {});
    const inside = textTokens.filter(token => overlapRatio(box, ensureBBox(token.geometry?.bbox || {})) >= 0.2);
    const edgeDensityProxy = Math.min(1, inside.length / Math.max(1, (box.w * box.h) / 4000));
    const textDensity = Math.min(1, inside.length / Math.max(1, (box.w * box.h) / 2500));

    // Shape descriptors — structure/geometry based, no text dependency
    const area = box.w * box.h;
    const aspectRatio = box.w / Math.max(1, box.h);
    // Rectangularity: how close the region's convex hull is to its bounding box
    // For bbox-based regions this is 1.0; for contour-based regions use hull area
    const hullArea = (region.geometry?.hullArea) || area;
    const rectangularity = area > 0 ? Math.min(1, hullArea / Math.max(1, area)) : 1;
    // Solidity: ratio of region area to convex hull area (compactness measure)
    const contourArea = (region.geometry?.contourArea) || area;
    const solidity = hullArea > 0 ? Math.min(1, contourArea / Math.max(1, hullArea)) : 1;
    // Normalized dimensions (fraction of page, if viewport known)
    const vpW = region._vpW || 1;
    const vpH = region._vpH || 1;
    const normW = box.w / Math.max(1, vpW);
    const normH = box.h / Math.max(1, vpH);

    return {
      ...region,
      textDensity,
      features: {
        ...region.features,
        area,
        tokenCount: inside.length,
        averageTokenConfidence: inside.reduce((s, tok) => s + (Number(tok.confidence) || 0), 0) / Math.max(1, inside.length),
        edgeDensityProxy,
        textureProxy: Math.max(0, 1 - Math.abs((box.w / Math.max(1, box.h)) - 1) * 0.2),
        // Structural shape descriptors
        aspectRatio,
        rectangularity,
        solidity,
        normW,
        normH
      }
    };
  });

  // Second pass: compute containment depth (how deeply nested each region is)
  for (let i = 0; i < enriched.length; i++) {
    const boxI = ensureBBox(enriched[i].geometry?.bbox || {});
    let depth = 0;
    for (let j = 0; j < enriched.length; j++) {
      if (i === j) continue;
      const boxJ = ensureBBox(enriched[j].geometry?.bbox || {});
      // Check if boxJ strictly contains boxI
      if (boxJ.x <= boxI.x && boxJ.y <= boxI.y &&
          (boxJ.x + boxJ.w) >= (boxI.x + boxI.w) &&
          (boxJ.y + boxJ.h) >= (boxI.y + boxI.h) &&
          (boxJ.w * boxJ.h) > (boxI.w * boxI.h) * 1.1) {
        depth++;
      }
    }
    enriched[i].features.containmentDepth = depth;
  }

  return enriched;
}

module.exports = {
  computeRegionFeatures
};
