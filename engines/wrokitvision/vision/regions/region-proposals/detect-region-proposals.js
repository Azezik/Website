'use strict';

const { createStructuralRegionNode, ensureBBox } = require('../../types');
const { unionBbox } = require('../../text/text-grouping/group-text-lines');

function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

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

function orientedRectFromMoments(points = [], fallbackBbox = {}){
  if(!points.length) return rotatedRectFromBbox(fallbackBbox);
  let mx = 0;
  let my = 0;
  for(const p of points){
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for(const p of points){
    const dx = p.x - mx;
    const dy = p.y - my;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= Math.max(1, points.length);
  yy /= Math.max(1, points.length);
  xy /= Math.max(1, points.length);
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for(const p of points){
    const dx = p.x - mx;
    const dy = p.y - my;
    const u = (dx * cosA) + (dy * sinA);
    const v = (-dx * sinA) + (dy * cosA);
    if(u < minU) minU = u;
    if(u > maxU) maxU = u;
    if(v < minV) minV = v;
    if(v > maxV) maxV = v;
  }
  const w = Math.max(1, maxU - minU);
  const h = Math.max(1, maxV - minV);
  return {
    center: { x: mx, y: my },
    size: { w, h },
    angleDeg: angle * (180 / Math.PI)
  };
}

function sobelBinary(gray, width, height, threshold = 80){
  const edges = new Uint8Array(width * height);
  for(let y = 1; y < height - 1; y++){
    for(let x = 1; x < width - 1; x++){
      const i = y * width + x;
      const gx = -gray[i-width-1] - 2 * gray[i-1] - gray[i+width-1]
               + gray[i-width+1] + 2 * gray[i+1] + gray[i+width+1];
      const gy = -gray[i-width-1] - 2 * gray[i-width] - gray[i-width+1]
               + gray[i+width-1] + 2 * gray[i+width] + gray[i+width+1];
      const g = Math.sqrt(gx * gx + gy * gy);
      edges[i] = g > threshold ? 1 : 0;
    }
  }
  return edges;
}

function hasStrongLocalEdgeBarrier({ edges, width, height, x0, y0, x1, y1, densityThreshold = 0.34 } = {}){
  if(!edges || !width || !height) return false;
  if(Math.abs(x1 - x0) + Math.abs(y1 - y0) !== 1) return false;
  let hits = 0;
  let samples = 0;

  if(x0 !== x1){
    const bx = Math.max(x0, x1);
    for(let dy = -1; dy <= 1; dy++){
      const sy = y0 + dy;
      if(bx < 0 || bx >= width || sy < 0 || sy >= height) continue;
      samples += 1;
      if(edges[(sy * width) + bx]) hits += 1;
    }
  } else {
    const by = Math.max(y0, y1);
    for(let dx = -1; dx <= 1; dx++){
      const sx = x0 + dx;
      if(sx < 0 || sx >= width || by < 0 || by >= height) continue;
      samples += 1;
      if(edges[(by * width) + sx]) hits += 1;
    }
  }

  if(samples <= 0) return false;
  return (hits / samples) >= densityThreshold;
}

function detectConnectedVisualProposals({ imageData, viewport, idFactory }){
  if(!imageData?.gray || !imageData.width || !imageData.height || !viewport?.width || !viewport?.height){
    return [];
  }

  const width = Number(imageData.width) || 0;
  const height = Number(imageData.height) || 0;
  if(width <= 2 || height <= 2) return [];

  const gray = imageData.gray;
  const edges = sobelBinary(gray, width, height, 80);
  let sum = 0;
  for(let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / Math.max(1, gray.length);

  const threshold = clamp(Math.round(mean * 0.82), 22, 220);
  const mask = new Uint8Array(width * height);
  for(let i = 0; i < gray.length; i++){
    mask[i] = gray[i] <= threshold ? 1 : 0;
  }

  const visited = new Uint8Array(width * height);
  const minArea = Math.max(100, Math.floor((width * height) * 0.0012));
  const maxArea = Math.floor((width * height) * 0.75);
  const sx = viewport.width / width;
  const sy = viewport.height / height;
  const proposals = [];

  for(let y = 0; y < height; y++){
    for(let x = 0; x < width; x++){
      const start = y * width + x;
      if(mask[start] !== 1 || visited[start]) continue;

      const q = [start];
      visited[start] = 1;
      let head = 0;
      let area = 0;
      let x0 = x, y0 = y, x1 = x, y1 = y;
      const pixels = [];
      const boundaryPixels = [];

      while(head < q.length){
        const idx = q[head++];
        const cx = idx % width;
        const cy = (idx / width) | 0;
        area += 1;
        pixels.push({ x: cx, y: cy });
        if(cx < x0) x0 = cx;
        if(cy < y0) y0 = cy;
        if(cx > x1) x1 = cx;
        if(cy > y1) y1 = cy;

        const neighbors = [
          { ni: idx - 1, nx: cx - 1, ny: cy },
          { ni: idx + 1, nx: cx + 1, ny: cy },
          { ni: idx - width, nx: cx, ny: cy - 1 },
          { ni: idx + width, nx: cx, ny: cy + 1 }
        ];
        let isBoundary = false;
        for(const { ni, nx, ny } of neighbors){
          if(nx < 0 || nx >= width || ny < 0 || ny >= height){
            isBoundary = true;
            continue;
          }
          if(mask[ni] !== 1){
            isBoundary = true;
            continue;
          }
          if(hasStrongLocalEdgeBarrier({ edges, width, height, x0: cx, y0: cy, x1: nx, y1: ny })){
            isBoundary = true;
            continue;
          }
          if(visited[ni]) continue;
          visited[ni] = 1;
          q.push(ni);
        }
        if(isBoundary) boundaryPixels.push({ x: cx, y: cy });
      }

      if(area < minArea || area > maxArea) continue;
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      if(bw < 10 || bh < 10) continue;

      const bbox = {
        x: x0 * sx,
        y: y0 * sy,
        w: bw * sx,
        h: bh * sy
      };

      const sampleStep = Math.max(1, Math.floor(boundaryPixels.length / 200));
      const contour = [];
      for(let i = 0; i < boundaryPixels.length; i += sampleStep){
        const bp = boundaryPixels[i];
        contour.push({ x: bp.x * sx, y: bp.y * sy });
      }
      const hull = convexHull(contour.length >= 3 ? contour : rectContourFromBbox(bbox));
      const rotatedRect = orientedRectFromMoments(
        pixels.length > 1200 ? pixels.filter((_, idx) => idx % Math.ceil(pixels.length / 1200) === 0).map(p => ({ x: p.x * sx, y: p.y * sy })) : pixels.map(p => ({ x: p.x * sx, y: p.y * sy })),
        bbox
      );

      proposals.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: {
          bbox,
          contour: contour.length >= 3 ? contour : rectContourFromBbox(bbox),
          hull: hull.length >= 3 ? hull : rectContourFromBbox(bbox),
          rotatedRect
        },
        confidence: 0.62,
        provenance: {
          stage: 'region-proposals',
          detector: 'connected-components-threshold',
          sourceType: 'visual'
        },
        features: {
          source: 'visual-connected-components',
          pixelArea: area,
          imageThreshold: threshold,
          boundaryComplexity: boundaryPixels.length / Math.max(1, area)
        },
        surfaceTypeCandidate: 'visual_component',
        textDensity: 0
      }));
    }
  }

  return proposals;
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

  regions.push(...detectConnectedVisualProposals({ imageData, viewport, idFactory }));

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

  return regions;
}

module.exports = {
  detectRegionProposals
};
