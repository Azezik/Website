'use strict';

const { ensureBBox, createNodeRelevanceScore } = require('../../vision/types');

function area(box){ return Math.max(0, box.w) * Math.max(0, box.h); }
function center(box){ return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) }; }
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
  return inter / Math.max(1, area(a) + area(b) - inter);
}

function distanceSignal(seedBox, box, viewport){
  const c1 = center(seedBox);
  const c2 = center(box);
  const diag = Math.max(1, Math.hypot(Number(viewport?.width) || 1, Number(viewport?.height) || 1));
  const d = Math.hypot(c1.x - c2.x, c1.y - c2.y) / diag;
  return Math.max(0, 1 - d);
}

function contains(a, b){
  return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
}

function normalizeAngleDeg(angle){
  const n = Number(angle);
  if(!Number.isFinite(n)) return null;
  const normalized = ((n % 360) + 360) % 360;
  return normalized;
}

function smallestAngularDifferenceDeg(a, b){
  const an = normalizeAngleDeg(a);
  const bn = normalizeAngleDeg(b);
  if(an == null || bn == null) return null;
  const diff = Math.abs(an - bn);
  return Math.min(diff, 360 - diff);
}

function estimateSeedOrientation({ selectionContext, lineById, blockById } = {}){
  const lineAngles = (selectionContext?.nearestLineIds || [])
    .map(id => lineById.get(id))
    .map(node => normalizeAngleDeg(node?.geometry?.orientation))
    .filter(v => v != null);
  if(lineAngles.length){
    return {
      orientation: lineAngles.reduce((sum, value) => sum + value, 0) / lineAngles.length,
      source: 'nearest_lines'
    };
  }
  const blockAngles = (selectionContext?.nearestBlockIds || [])
    .map(id => blockById.get(id))
    .map(node => normalizeAngleDeg(node?.geometry?.orientation))
    .filter(v => v != null);
  if(blockAngles.length){
    return {
      orientation: blockAngles.reduce((sum, value) => sum + value, 0) / blockAngles.length,
      source: 'nearest_blocks'
    };
  }
  return {
    orientation: null,
    source: 'unavailable'
  };
}

function orientationSignal(seedOrientation, candidateOrientation){
  const angularDifference = smallestAngularDifferenceDeg(seedOrientation, candidateOrientation);
  if(angularDifference == null){
    return {
      score: 0.5,
      angularDifference: null,
      source: 'fallback-neutral'
    };
  }
  return {
    score: Math.max(0, 1 - (angularDifference / 180)),
    angularDifference,
    source: 'orientation-angle'
  };
}

function scoreNode({ node, nodeType, seedBox, viewport, selectionContext, lineById, blockById, regionById, seedOrientationMeta } = {}){
  const box = ensureBBox(node?.geometry?.bbox || {});
  const overlap = iou(seedBox, box);
  const distance = distanceSignal(seedBox, box, viewport);
  const containment = contains(seedBox, box) || contains(box, seedBox) ? 1 : 0;
  const sharedParentRegion = (node?.regionId && selectionContext?.intersectingRegionIds?.includes(node.regionId)) ? 1 : 0;

  let topology = 0;
  if(nodeType === 'text_token'){
    if(selectionContext?.nearestLineIds?.includes(node.parentLineId)) topology += 0.7;
    if(selectionContext?.nearestBlockIds?.includes(node.parentBlockId)) topology += 0.5;
  } else if(nodeType === 'text_line'){
    const parentBlock = node.parentBlockId && blockById.get(node.parentBlockId);
    if(parentBlock && selectionContext?.nearestBlockIds?.includes(parentBlock.id)) topology += 0.8;
  } else if(nodeType === 'text_block'){
    if(selectionContext?.nearestBlockIds?.includes(node.id)) topology += 0.8;
  } else if(nodeType === 'structural_region'){
    if(selectionContext?.intersectingRegionIds?.includes(node.id)) topology += 0.9;
    if(selectionContext?.containingRegionIds?.includes(node.id)) topology += 0.6;
  } else if(nodeType === 'surface_candidate'){
    const support = Array.isArray(node.supportingRegionIds) ? node.supportingRegionIds : [];
    if(support.some(id => selectionContext?.intersectingRegionIds?.includes(id))) topology += 0.75;
  }

  const adjacency = (() => {
    if(nodeType === 'text_token' && node.parentLineId && selectionContext?.nearestLineIds?.includes(node.parentLineId)) return 1;
    if(nodeType === 'text_line' && node.parentBlockId && selectionContext?.nearestBlockIds?.includes(node.parentBlockId)) return 0.8;
    if(nodeType === 'text_block' && Array.isArray(node.lineIds) && node.lineIds.some(id => selectionContext?.nearestLineIds?.includes(id))) return 0.75;
    if(nodeType === 'structural_region' && Array.isArray(selectionContext?.intersectingRegionIds) && selectionContext.intersectingRegionIds.length){
      const parent = regionById.get(node.id);
      return parent ? 0.5 : 0;
    }
    return 0;
  })();

  const alignMeta = orientationSignal(seedOrientationMeta?.orientation, node?.geometry?.orientation);
  const provenance = Number(node?.provenance?.weight) || 0.5;
  const confidence = Number(node?.confidence);
  const textConfidence = Number.isFinite(confidence) ? confidence : 0.5;

  const components = {
    overlap,
    distance,
    containment,
    sharedParentRegion,
    topology: Math.max(0, Math.min(1, topology)),
    adjacency,
    alignment: alignMeta.score,
    alignmentAngleDelta: alignMeta.angularDifference,
    alignmentSource: alignMeta.source,
    seedOrientation: seedOrientationMeta?.orientation,
    provenance,
    textConfidence
  };

  const weights = {
    overlap: 0.26,
    distance: 0.2,
    containment: 0.12,
    sharedParentRegion: 0.1,
    topology: 0.14,
    adjacency: 0.08,
    alignment: 0.04,
    provenance: 0.03,
    textConfidence: 0.03
  };

  let total = 0;
  Object.keys(weights).forEach((key) => {
    total += (components[key] || 0) * weights[key];
  });

  return createNodeRelevanceScore({
    nodeId: node.id,
    nodeType,
    score: total,
    retained: total >= 0.22,
    scoreComponents: components,
    provenance: node?.provenance || null
  });
}

function scoreLocalRelevance({ canonicalPrecomputed, selectionSeed, selectionContext } = {}){
  const analysis = canonicalPrecomputed?.uploadedImageAnalysis || {};
  const seedBox = ensureBBox(selectionSeed?.bbox || {});
  const viewport = analysis.viewport || null;

  const lineById = new Map((analysis.textLines || []).map(n => [n.id, n]));
  const blockById = new Map((analysis.textBlocks || []).map(n => [n.id, n]));
  const regionById = new Map((analysis.regionNodes || []).map(n => [n.id, n]));
  const seedOrientationMeta = estimateSeedOrientation({ selectionContext, lineById, blockById });

  const allScores = [];
  const gather = (nodes, nodeType) => {
    (Array.isArray(nodes) ? nodes : []).forEach((node) => {
      allScores.push(scoreNode({ node, nodeType, seedBox, viewport, selectionContext, lineById, blockById, regionById, seedOrientationMeta }));
    });
  };

  gather(analysis.textTokens, 'text_token');
  gather(analysis.textLines, 'text_line');
  gather(analysis.textBlocks, 'text_block');
  gather(analysis.regionNodes, 'structural_region');
  gather(analysis.surfaceCandidates, 'surface_candidate');

  allScores.sort((a, b) => b.score - a.score);

  return {
    nodeScores: allScores,
    retainedNodeIds: allScores.filter(s => s.retained).map(s => s.nodeId),
    rejectedNodeIds: allScores.filter(s => !s.retained).map(s => s.nodeId)
  };
}

module.exports = {
  scoreLocalRelevance
};
