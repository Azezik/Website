'use strict';

function buildRegionProposalOverlay(regionNodes = []){
  return { layer: 'region-proposals', count: regionNodes.length, items: regionNodes };
}

function buildRegionGraphOverlay(regionGraph = { nodes: [], edges: [] }){
  return { layer: 'region-graph', nodeCount: regionGraph.nodes.length, edgeCount: regionGraph.edges.length, graph: regionGraph };
}

function buildTextTokenOverlay(textTokens = []){
  return { layer: 'text-tokens', count: textTokens.length, items: textTokens };
}

function buildTextLineOverlay(textLines = []){
  return { layer: 'text-lines', count: textLines.length, items: textLines };
}

function buildTextBlockOverlay(textBlocks = []){
  return { layer: 'text-blocks', count: textBlocks.length, items: textBlocks };
}

function buildTextGraphOverlay(textGraph = { nodes: [], edges: [] }){
  return { layer: 'text-graph', nodeCount: textGraph.nodes.length, edgeCount: textGraph.edges.length, graph: textGraph };
}

function buildSurfaceCandidateOverlay(surfaceCandidates = []){
  return { layer: 'surface-candidates', count: surfaceCandidates.length, items: surfaceCandidates };
}

module.exports = {
  buildRegionProposalOverlay,
  buildRegionGraphOverlay,
  buildTextTokenOverlay,
  buildTextLineOverlay,
  buildTextBlockOverlay,
  buildTextGraphOverlay,
  buildSurfaceCandidateOverlay
};
