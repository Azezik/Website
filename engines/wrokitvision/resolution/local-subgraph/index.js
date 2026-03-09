'use strict';

const { createResolvedLocalSubgraph } = require('../../vision/types');

function pickNodes(nodes, retainedIds){
  const kept = [];
  const rejected = [];
  const retained = new Set(retainedIds || []);
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    if(retained.has(node.id)) kept.push(node);
    else rejected.push(node.id);
  });
  return { kept, rejected };
}

function buildParentChains({ tokens = [], lines = [], blocks = [] } = {}){
  const lineById = new Map(lines.map(n => [n.id, n]));
  const blockById = new Map(blocks.map(n => [n.id, n]));
  return tokens.map((tok) => ({
    tokenId: tok.id,
    lineId: tok.parentLineId || null,
    blockId: tok.parentBlockId || (tok.parentLineId ? lineById.get(tok.parentLineId)?.parentBlockId || null : null),
    blockNodePresent: !!(tok.parentBlockId && blockById.get(tok.parentBlockId))
  }));
}

function resolveLocalSubgraph({ canonicalPrecomputed, associationResult, relevanceResult } = {}){
  const analysis = canonicalPrecomputed?.uploadedImageAnalysis || {};
  const retained = relevanceResult?.retainedNodeIds || [];

  const tokens = pickNodes(analysis.textTokens, retained);
  const lines = pickNodes(analysis.textLines, retained);
  const blocks = pickNodes(analysis.textBlocks, retained);
  const regions = pickNodes(analysis.regionNodes, retained);
  const surfaces = pickNodes(analysis.surfaceCandidates, retained);

  const keptSet = new Set(retained);
  const textEdges = (analysis.textGraph?.edges || []).filter(edge => keptSet.has(edge.sourceNodeId) || keptSet.has(edge.targetNodeId));
  const regionEdges = (analysis.regionGraph?.edges || []).filter(edge => keptSet.has(edge.sourceNodeId) || keptSet.has(edge.targetNodeId));

  const synthesizedSurfaceEdges = surfaces.kept.flatMap((surface) => {
    const support = Array.isArray(surface.supportingRegionIds) ? surface.supportingRegionIds : [];
    return support
      .filter(regionId => keptSet.has(regionId))
      .map((regionId, index) => ({
        edgeId: `${surface.id}_support_${index}`,
        sourceNodeId: surface.id,
        targetNodeId: regionId,
        edgeType: 'surface_supports_region',
        weight: 0.8,
        provenance: { stage: 'selection-local-subgraph' }
      }));
  });

  return createResolvedLocalSubgraph({
    selectionSeed: associationResult?.selectionSeed || null,
    selectionContext: associationResult?.selectionContext || null,
    retainedTextTokenNodes: tokens.kept,
    retainedTextLineNodes: lines.kept,
    retainedTextBlockNodes: blocks.kept,
    retainedRegionNodes: regions.kept,
    retainedSurfaceCandidates: surfaces.kept,
    retainedTypedEdges: [...textEdges, ...regionEdges, ...synthesizedSurfaceEdges],
    relevanceScores: relevanceResult?.nodeScores || [],
    rejectedNodeIds: [
      ...tokens.rejected,
      ...lines.rejected,
      ...blocks.rejected,
      ...regions.rejected,
      ...surfaces.rejected
    ],
    inferredParentChain: buildParentChains({ tokens: tokens.kept, lines: lines.kept, blocks: blocks.kept }),
    neighborhoodMeta: {
      retainedNodeCount: retained.length,
      retainedEdgeCount: textEdges.length + regionEdges.length + synthesizedSurfaceEdges.length
    }
  });
}

module.exports = {
  resolveLocalSubgraph
};
