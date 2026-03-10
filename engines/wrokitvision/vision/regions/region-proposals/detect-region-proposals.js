'use strict';

const { createStructuralRegionNode, ensureBBox } = require('../../types');
const { unionBbox } = require('../../text/text-grouping/group-text-lines');
const { buildAtomicVisualSegments, extractRegionContour } = require('./atomic-visual-segmentation');

function rectContourFromBbox(bbox = {}){
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

function rotatedRectFromBbox(bbox = {}){
  const x = Number(bbox.x) || 0;
  const y = Number(bbox.y) || 0;
  const w = Math.max(0, Number(bbox.w) || 0);
  const h = Math.max(0, Number(bbox.h) || 0);
  return {
    center: { x: x + (w / 2), y: y + (h / 2) },
    size: { w, h },
    angleDeg: 0
  };
}

function cross(o, a, b){
  return ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
}

function convexHull(points = []){
  if(!Array.isArray(points) || points.length < 3) return points || [];
  const unique = [];
  const seen = new Set();
  for(const p of points){
    if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const key = `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    unique.push({ x: p.x, y: p.y });
  }
  if(unique.length < 3) return unique;
  unique.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const lower = [];
  for(const p of unique){
    while(lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for(let i = unique.length - 1; i >= 0; i--){
    const p = unique[i];
    while(upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function orientedRectFromContour(contour, fallbackBbox){
  if(!Array.isArray(contour) || contour.length < 3) return rotatedRectFromBbox(fallbackBbox);
  let mx = 0, my = 0;
  for(const p of contour){ mx += p.x; my += p.y; }
  mx /= contour.length;
  my /= contour.length;
  let xx = 0, yy = 0, xy = 0;
  for(const p of contour){
    const dx = p.x - mx;
    const dy = p.y - my;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= contour.length;
  yy /= contour.length;
  xy /= contour.length;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for(const p of contour){
    const dx = p.x - mx;
    const dy = p.y - my;
    const u = (dx * cosA) + (dy * sinA);
    const v = (-dx * sinA) + (dy * cosA);
    if(u < minU) minU = u;
    if(u > maxU) maxU = u;
    if(v < minV) minV = v;
    if(v > maxV) maxV = v;
  }
  return {
    center: { x: mx, y: my },
    size: { w: Math.max(1, maxU - minU), h: Math.max(1, maxV - minV) },
    angleDeg: angle * (180 / Math.PI)
  };
}

function detectConnectedVisualProposals({ imageData, viewport, idFactory }){
  if(!imageData?.gray || !imageData.width || !imageData.height || !viewport?.width || !viewport?.height){
    return { proposals: [], atomicFragments: [] };
  }

  const width = Number(imageData.width) || 0;
  const height = Number(imageData.height) || 0;
  // Raised from 0.0012 to 0.0015 based on Session A annotation evidence
  // (avgAutoRegionCount 43.3 vs avgHumanRegionCount 11, precision 0.118):
  // small colour-connected fragments are the primary source of false detections
  // in mixed-content images.  +25% floor eliminates the smallest fragments
  // without affecting text-derived proposals (OCR lines are sourced separately).
  // Session B contract document is unaffected — its label/value candidates
  // come from text lines, not visual colour regions.
  const minArea = Math.max(100, Math.floor((width * height) * 0.0015));
  const maxArea = Math.floor((width * height) * 0.75);
  // Lower fragment threshold captures small atomic regions that survive merging.
  // These are the "camo patches" — genuine color-connected primitives that trace
  // local shape geometry with high fidelity.  Exposed for debug visualization.
  const fragmentMinArea = Math.max(16, Math.floor((width * height) * 0.00015));
  const sx = viewport.width / width;
  const sy = viewport.height / height;
  const proposals = [];
  const atomicFragments = [];
  const segmented = buildAtomicVisualSegments({ imageData });
  if(!segmented) return { proposals, atomicFragments };

  for(const merged of segmented.mergedRegions){
      const area = merged.area;
      const bw = merged.x1 - merged.x0 + 1;
      const bh = merged.y1 - merged.y0 + 1;

      // Capture small fragments as atomic primitives before filtering them out
      // of the main proposals.  These fragments contain high-fidelity boundary
      // information useful for shape detection and debugging.
      if(area >= fragmentMinArea && area < minArea && bw >= 2 && bh >= 2){
        atomicFragments.push({
          id: idFactory('atomic_fragment'),
          bbox: { x: merged.x0 * sx, y: merged.y0 * sy, w: bw * sx, h: bh * sy },
          pixelArea: area,
          atomicCount: merged.atomicCount
        });
        continue;
      }

      if(area < minArea || area > maxArea) continue;
      if(bw < 10 || bh < 10) continue;

      const bbox = {
        x: merged.x0 * sx,
        y: merged.y0 * sy,
        w: bw * sx,
        h: bh * sy
      };

      // Extract real contour from the label map when available
      let contour = null;
      if(segmented.labels && merged.rootIds && segmented.find){
        const mergedIdSet = new Set();
        for(const rid of merged.rootIds){
          mergedIdSet.add(segmented.find(rid));
        }
        // Attach bbox hints for the scan range
        mergedIdSet._x0 = merged.x0;
        mergedIdSet._y0 = merged.y0;
        mergedIdSet._x1 = merged.x1;
        mergedIdSet._y1 = merged.y1;
        contour = extractRegionContour(segmented.labels, mergedIdSet, width, height, sx, sy);
      }

      const fallbackContour = rectContourFromBbox(bbox);
      const resolvedContour = (contour && contour.length >= 3) ? contour : fallbackContour;
      const hull = convexHull(resolvedContour);
      const rotatedRect = (contour && contour.length >= 3)
        ? orientedRectFromContour(contour, bbox)
        : rotatedRectFromBbox(bbox);

      proposals.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: {
          bbox,
          contour: resolvedContour,
          hull: hull.length >= 3 ? hull : fallbackContour,
          rotatedRect
        },
        confidence: 0.62,
        provenance: {
          stage: 'region-proposals',
          detector: 'atomic-region-merge',
          sourceType: 'visual'
        },
        features: {
          source: 'visual-atomic-region-merge',
          pixelArea: area,
          atomicRegionCount: merged.atomicCount,
          atomicSeedCount: segmented.atomicCount,
          boundaryFirst: true,
          hasRealContour: !!(contour && contour.length >= 3)
        },
        surfaceTypeCandidate: 'visual_component',
        textDensity: 0
      }));
  }

  return { proposals, atomicFragments };
}

function detectRegionProposals({ textLines = [], viewport, idFactory, imageData = null } = {}){
  const regions = [];
  for(const line of textLines){
    const box = ensureBBox(line.geometry?.bbox || {});
    const padX = Math.max(4, box.h * 0.5);
    const padY = Math.max(2, box.h * 0.25);
    const lineBbox = { x: box.x - padX, y: box.y - padY, w: box.w + (padX * 2), h: box.h + (padY * 2) };
    regions.push(createStructuralRegionNode({
      id: idFactory('region'),
      geometry: { bbox: lineBbox, contour: rectContourFromBbox(lineBbox), hull: rectContourFromBbox(lineBbox), rotatedRect: rotatedRectFromBbox(lineBbox) },
      confidence: line.confidence,
      provenance: { stage: 'region-proposals', detector: 'line-envelope', sourceType: 'ocr', sourceLineId: line.id },
      features: { sourceLineId: line.id, sourceTokenCount: line.tokenIds?.length || 0 },
      surfaceTypeCandidate: 'text_strip',
      textDensity: 1
    }));
  }

  if(textLines.length){
    const pageTextBounds = unionBbox(textLines.map(line => line.geometry?.bbox || {}));
    regions.push(createStructuralRegionNode({
      id: idFactory('region'),
      geometry: { bbox: pageTextBounds, contour: rectContourFromBbox(pageTextBounds), hull: rectContourFromBbox(pageTextBounds), rotatedRect: rotatedRectFromBbox(pageTextBounds) },
      confidence: 0.65,
      provenance: { stage: 'region-proposals', detector: 'text-hull', sourceType: 'ocr' },
      features: { aggregatedLineCount: textLines.length },
      surfaceTypeCandidate: 'text_cluster',
      textDensity: 0.85
    }));
  }

  const visualResult = detectConnectedVisualProposals({ imageData, viewport, idFactory });
  regions.push(...visualResult.proposals);

  if(viewport?.width && viewport?.height){
    const pageBox = { x: 0, y: 0, w: viewport.width, h: viewport.height };
    regions.push(createStructuralRegionNode({
      id: idFactory('region'),
      geometry: { bbox: pageBox, contour: rectContourFromBbox(pageBox), hull: rectContourFromBbox(pageBox), rotatedRect: rotatedRectFromBbox(pageBox) },
      confidence: 0.45,
      provenance: { stage: 'region-proposals', detector: 'page-frame', sourceType: 'layout' },
      features: { viewportArea: viewport.width * viewport.height },
      surfaceTypeCandidate: 'page_surface',
      textDensity: textLines.length ? 0.3 : 0
    }));
  }

  return {
    regions,
    atomicFragments: visualResult.atomicFragments || []
  };
}

module.exports = {
  detectRegionProposals
};
