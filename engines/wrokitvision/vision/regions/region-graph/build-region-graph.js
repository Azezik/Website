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
  // Per-node degree cap for proximity edges.  Without a cap, a large central
  // region (e.g. the text_cluster whose bbox spans the full image width) becomes
  // a hub connecting to every other node, producing the dense fan pattern
  // visible in the edge graph overlay.  Capping at 5 keeps the graph sparse.
  const proximityDegree = new Map();
  const MAX_PROXIMITY_DEGREE = 5;
  for(let i = 0; i < regionNodes.length; i++){
    for(let j = i + 1; j < regionNodes.length; j++){
      const a = regionNodes[i];
      const b = regionNodes[j];
      const boxA = ensureBBox(a.geometry?.bbox || {});
      const boxB = ensureBBox(b.geometry?.bbox || {});
      const distance = boxDistance(boxA, boxB);
      // Reduced from 800 → 400: only connect genuinely nearby neighbours.
      // 800 covered the entire width of a typical image, turning the graph
      // into a near-complete graph dominated by one large hub node.  400
      // captures local adjacency while still spanning multi-column layouts
      // in typical document viewports.
      const proximity = Math.max(0, 1 - (distance / 400));

      if(proximity > 0.1){
        const degA = proximityDegree.get(a.id) || 0;
        const degB = proximityDegree.get(b.id) || 0;
        if(degA < MAX_PROXIMITY_DEGREE && degB < MAX_PROXIMITY_DEGREE){
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
            proximityDegree.set(a.id, degA + 1);
            proximityDegree.set(b.id, degB + 1);
          }
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
