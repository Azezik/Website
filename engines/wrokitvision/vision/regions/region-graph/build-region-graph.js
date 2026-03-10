'use strict';

const { createGraphEdge, createScoreBreakdown, ensureBBox } = require('../../types');

function boxDistance(a, b){
  const acx = a.x + (a.w / 2);
  const acy = a.y + (a.h / 2);
  const bcx = b.x + (b.w / 2);
  const bcy = b.y + (b.h / 2);
  return Math.hypot(acx - bcx, acy - bcy);
}

function contains(a, b){
  return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
}

function confidenceSimilarity(a, b){
  // Regions from the same detector with similar confidence are more likely related.
  // Regions from different sourceTypes get a mild penalty.
  const sameSource = (a.provenance?.sourceType === b.provenance?.sourceType) ? 1.0 : 0.85;
  const confDelta = Math.abs((Number(a.confidence) || 0.5) - (Number(b.confidence) || 0.5));
  return sameSource * Math.max(0, 1 - confDelta * 2);
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
        // Weight proximity edges by source similarity so that high-contrast
        // regions from different visual origins don't form strong graph links
        // purely from spatial closeness.
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

      if(contains(boxA, boxB) || contains(boxB, boxA)){
        edges.push(createGraphEdge({
          edgeId: idFactory('edge_region'),
          sourceNodeId: contains(boxA, boxB) ? a.id : b.id,
          targetNodeId: contains(boxA, boxB) ? b.id : a.id,
          edgeType: 'contains',
          weight: 0.95,
          rationale: createScoreBreakdown({ total: 0.95, notes: ['region containment relationship'] }),
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
