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

function detectConnectedVisualProposals({ imageData, viewport, idFactory }){
  if(!imageData?.gray || !imageData.width || !imageData.height || !viewport?.width || !viewport?.height){
    return [];
  }

  const width = Number(imageData.width) || 0;
  const height = Number(imageData.height) || 0;
  if(width <= 2 || height <= 2) return [];

  const gray = imageData.gray;
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

      while(head < q.length){
        const idx = q[head++];
        const cx = idx % width;
        const cy = (idx / width) | 0;
        area += 1;
        if(cx < x0) x0 = cx;
        if(cy < y0) y0 = cy;
        if(cx > x1) x1 = cx;
        if(cy > y1) y1 = cy;

        const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
        for(const ni of neighbors){
          if(ni < 0 || ni >= mask.length || visited[ni] || mask[ni] !== 1) continue;
          const nx = ni % width;
          const ny = (ni / width) | 0;
          if(Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          visited[ni] = 1;
          q.push(ni);
        }
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
      proposals.push(createStructuralRegionNode({
        id: idFactory('region'),
        geometry: { bbox, contour: rectContourFromBbox(bbox), hull: rectContourFromBbox(bbox), rotatedRect: rotatedRectFromBbox(bbox) },
        confidence: 0.58,
        provenance: {
          stage: 'region-proposals',
          detector: 'connected-components-threshold',
          sourceType: 'visual'
        },
        features: {
          source: 'visual-connected-components',
          pixelArea: area,
          imageThreshold: threshold
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
