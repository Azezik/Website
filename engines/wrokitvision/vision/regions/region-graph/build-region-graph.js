'use strict';

const { createGraphEdge, createScoreBreakdown, ensureBBox } = require('../../types');

function boxDistance(a, b){
  const acx = a.x + (a.w / 2);
  const acy = a.y + (a.h / 2);
  const bcx = b.x + (b.w / 2);
  const bcy = b.y + (b.h / 2);
  return Math.hypot(acx - bcx, acy - bcy);
}

function bboxArea(b){ return b.w * b.h; }

function contains(a, b){
  return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
}

function bboxIntersection(a, b){
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if(x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function confidenceSimilarity(a, b){
  const sameSource = (a.provenance?.sourceType === b.provenance?.sourceType) ? 1.0 : 0.85;
  const confDelta = Math.abs((Number(a.confidence) || 0.5) - (Number(b.confidence) || 0.5));
  return sameSource * Math.max(0, 1 - confDelta * 2);
}

function detectAdjacency(boxA, boxB, tolerance){
  if(!tolerance) tolerance = 8;
  const overlapX = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x);
  const overlapY = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y);

  // Horizontal adjacency: vertically overlapping, horizontally abutting
  if(overlapY > tolerance){
    const gapX = Math.max(boxA.x, boxB.x) - Math.min(boxA.x + boxA.w, boxB.x + boxB.w);
    if(gapX >= -tolerance && gapX <= tolerance){
      const sharedLen = overlapY;
      const minH = Math.min(boxA.h, boxB.h);
      return { axis: 'horizontal', sharedLength: sharedLen, sharedRatio: sharedLen / Math.max(1, minH) };
    }
  }
  // Vertical adjacency: horizontally overlapping, vertically abutting
  if(overlapX > tolerance){
    const gapY = Math.max(boxA.y, boxB.y) - Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
    if(gapY >= -tolerance && gapY <= tolerance){
      const sharedLen = overlapX;
      const minW = Math.min(boxA.w, boxB.w);
      return { axis: 'vertical', sharedLength: sharedLen, sharedRatio: sharedLen / Math.max(1, minW) };
    }
  }
  return null;
}

function buildRegionGraph(regionNodes = [], { idFactory } = {}){
  const edges = [];
  for(let i = 0; i < regionNodes.length; i++){
    for(let j = i + 1; j < regionNodes.length; j++){
      const a = regionNodes[i];
      const b = regionNodes[j];
      const boxA = ensureBBox(a.geometry?.bbox || {});
      const boxB = ensureBBox(b.geometry?.bbox || {});
      const distance = boxDistance(boxA, boxB);
      const proximity = Math.max(0, 1 - (distance / 800));

      if(proximity > 0.1){
        const similarity = confidenceSimilarity(a, b);
        const weight = proximity * similarity;
        if(weight > 0.08){
          edges.push(createGraphEdge({
            edgeId: idFactory('edge_region'),
            sourceNodeId: a.id,
            targetNodeId: b.id,
            edgeType: 'spatial_proximity',
            weight,
            rationale: createScoreBreakdown({ total: weight, components: [{ key: 'distance', value: proximity }, { key: 'similarity', value: similarity }] }),
            provenance: { stage: 'region-graph' }
          }));
        }
      }

      // Containment edges: use depth-aware hierarchy when available.
      // Prefer direct parent→child over transitive containment.
      const aContainsB = contains(boxA, boxB);
      const bContainsA = contains(boxB, boxA);
      if(aContainsB || bContainsA){
        const container = aContainsB ? a : b;
        const contained = aContainsB ? b : a;
        const containerBox = aContainsB ? boxA : boxB;
        const containedBox = aContainsB ? boxB : boxA;

        // Compute area ratio for containment weight — tighter fit = stronger
        const areaRatio = bboxArea(containedBox) / Math.max(1, bboxArea(containerBox));
        const depthDelta = Math.abs(
          (Number(container.features?.containmentDepth) || 0) -
          (Number(contained.features?.containmentDepth) || 0)
        );
        // Direct parent (depth delta = 1) gets full weight; deeper ancestors get less
        const depthWeight = depthDelta <= 1 ? 0.95 : Math.max(0.5, 0.95 - (depthDelta - 1) * 0.15);

        edges.push(createGraphEdge({
          edgeId: idFactory('edge_region'),
          sourceNodeId: container.id,
          targetNodeId: contained.id,
          edgeType: 'contains',
          weight: depthWeight,
          rationale: createScoreBreakdown({
            total: depthWeight,
            components: [
              { key: 'areaRatio', value: areaRatio },
              { key: 'depthDelta', value: depthDelta }
            ],
            notes: ['region containment relationship']
          }),
          provenance: { stage: 'region-graph' }
        }));
      }

      // Adjacency edges: regions that share an edge (tile-like behavior)
      const adjacency = detectAdjacency(boxA, boxB, 8);
      if(adjacency && adjacency.sharedRatio > 0.15){
        const adjWeight = Math.min(0.9, 0.4 + adjacency.sharedRatio * 0.5);
        edges.push(createGraphEdge({
          edgeId: idFactory('edge_region'),
          sourceNodeId: a.id,
          targetNodeId: b.id,
          edgeType: 'spatial_adjacency',
          weight: adjWeight,
          rationale: createScoreBreakdown({
            total: adjWeight,
            components: [
              { key: 'sharedLength', value: adjacency.sharedLength },
              { key: 'sharedRatio', value: adjacency.sharedRatio },
              { key: 'axis', value: adjacency.axis === 'horizontal' ? 1 : 0 }
            ],
            notes: [`adjacent along ${adjacency.axis} axis`]
          }),
          provenance: { stage: 'region-graph' }
        }));
      }
    }
  }

  return {
    nodes: regionNodes,
    edges
  };
}

module.exports = {
  buildRegionGraph
};
