'use strict';

const { ensureBBox, createSelectionSeed, createSelectionContext, createSelectionAssociationResult } = require('../../vision/types');

function area(box){
  return Math.max(0, box.w) * Math.max(0, box.h);
}

function center(box){
  return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) };
}

function intersectionArea(a, b){
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if(x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function iou(a, b){
  const inter = intersectionArea(a, b);
  if(inter <= 0) return 0;
  const denom = Math.max(1, area(a) + area(b) - inter);
  return inter / denom;
}

function contains(a, b){
  return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
}

function centerDistanceNorm(a, b, viewport){
  const ca = center(a);
  const cb = center(b);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  const diag = Math.hypot(Number(viewport?.width) || 1, Number(viewport?.height) || 1) || 1;
  return Math.hypot(dx, dy) / diag;
}

function orientationCompatibility(seedNode, candidateNode){
  const sa = Number(seedNode?.orientation) || 0;
  const sb = Number(candidateNode?.geometry?.orientation) || 0;
  const diff = Math.abs(sa - sb);
  return Math.max(0, 1 - (Math.min(180, diff) / 180));
}

function selectIds(nodes, predicate){
  return (Array.isArray(nodes) ? nodes : []).filter(predicate).map(n => n.id).filter(Boolean);
}

function resolveSeed({ selection, viewport, page, fieldMeta, precomputedStructuralMap } = {}){
  const seedBox = ensureBBox(selection?.bbox || selection || {});
  const vp = {
    width: Math.max(1, Number(viewport?.width || viewport?.w || precomputedStructuralMap?.uploadedImageAnalysis?.viewport?.width) || 1),
    height: Math.max(1, Number(viewport?.height || viewport?.h || precomputedStructuralMap?.uploadedImageAnalysis?.viewport?.height) || 1)
  };
  return createSelectionSeed({
    bbox: seedBox,
    polygon: Array.isArray(selection?.polygon) ? selection.polygon : null,
    normalized: {
      x: seedBox.x / vp.width,
      y: seedBox.y / vp.height,
      w: seedBox.w / vp.width,
      h: seedBox.h / vp.height
    },
    page: Number(page || selection?.page || precomputedStructuralMap?.page || 1),
    imageRef: precomputedStructuralMap?.uploadedImageAnalysis?.imageRef || null,
    fieldMeta: fieldMeta || null
  });
}

function associateSelection({ selectionSeed, canonicalPrecomputed } = {}){
  const analysis = canonicalPrecomputed?.uploadedImageAnalysis || {};
  const seedBox = ensureBBox(selectionSeed?.bbox || {});
  const viewport = analysis.viewport || null;
  const seedLikeNode = { orientation: 0 };

  const tokenNodes = Array.isArray(analysis.textTokens) ? analysis.textTokens : [];
  const lineNodes = Array.isArray(analysis.textLines) ? analysis.textLines : [];
  const blockNodes = Array.isArray(analysis.textBlocks) ? analysis.textBlocks : [];
  const regionNodes = Array.isArray(analysis.regionNodes) ? analysis.regionNodes : [];
  const surfaceNodes = Array.isArray(analysis.surfaceCandidates) ? analysis.surfaceCandidates : [];

  const overlapsTokenIds = selectIds(tokenNodes, (node) => intersectionArea(seedBox, ensureBBox(node?.geometry?.bbox)) > 0);
  const nearestLineIds = lineNodes
    .map((node) => ({ id: node.id, d: centerDistanceNorm(seedBox, ensureBBox(node?.geometry?.bbox), viewport) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(x => x.id)
    .filter(Boolean);

  const nearestBlockIds = blockNodes
    .map((node) => ({ id: node.id, d: centerDistanceNorm(seedBox, ensureBBox(node?.geometry?.bbox), viewport) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map(x => x.id)
    .filter(Boolean);

  const intersectingRegionIds = selectIds(regionNodes, (node) => intersectionArea(seedBox, ensureBBox(node?.geometry?.bbox)) > 0);
  const containingRegionIds = selectIds(regionNodes, (node) => contains(ensureBBox(node?.geometry?.bbox), seedBox));

  const nearbySurfaceCandidateIds = surfaceNodes
    .map((node) => {
      const bbox = ensureBBox(node?.geometry?.bbox);
      const signal = (iou(seedBox, bbox) * 0.6)
        + ((1 - centerDistanceNorm(seedBox, bbox, viewport)) * 0.25)
        + (orientationCompatibility(seedLikeNode, node) * 0.15);
      return { id: node.id, signal };
    })
    .filter(item => item.signal > 0.05)
    .sort((a, b) => b.signal - a.signal)
    .slice(0, 6)
    .map(item => item.id)
    .filter(Boolean);

  return createSelectionAssociationResult({
    selectionSeed,
    selectionContext: createSelectionContext({
      overlappingTokenIds: overlapsTokenIds,
      nearestLineIds,
      nearestBlockIds,
      intersectingRegionIds,
      containingRegionIds,
      nearbySurfaceCandidateIds,
      artifactRefs: {
        precomputedStructuralMap: {
          schema: canonicalPrecomputed?.schema || null,
          version: canonicalPrecomputed?.version || null,
          geometryId: canonicalPrecomputed?.geometryId || null,
          page: canonicalPrecomputed?.page || null,
          analysisId: analysis?.analysisId || null
        }
      }
    })
  });
}

module.exports = {
  resolveSeed,
  associateSelection
};
