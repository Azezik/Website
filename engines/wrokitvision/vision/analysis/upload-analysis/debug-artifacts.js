'use strict';

function ensureBbox(bbox = {}){
  return {
    x: Number(bbox.x) || 0,
    y: Number(bbox.y) || 0,
    w: Math.max(0, Number(bbox.w) || 0),
    h: Math.max(0, Number(bbox.h) || 0)
  };
}

function toGeometryShape(region){
  const geometry = region?.geometry || {};
  const bbox = ensureBbox(geometry.bbox || {});
  if(Array.isArray(geometry.contour) && geometry.contour.length >= 3){
    return { kind: 'contour', points: geometry.contour, bbox };
  }
  if(Array.isArray(geometry.hull) && geometry.hull.length >= 3){
    return { kind: 'hull', points: geometry.hull, bbox };
  }
  if(geometry.rotatedRect?.center){
    return { kind: 'rotated_rect', rotatedRect: geometry.rotatedRect, bbox };
  }
  return { kind: 'bbox', bbox };
}

function buildRegionProposalOverlay(regionNodes = []){
  return {
    layer: 'region-proposals-bbox-debug',
    role: 'compatibility-bbox-debug',
    count: regionNodes.length,
    items: regionNodes
  };
}

function buildRegionGeometryOverlay(regionNodes = []){
  const items = regionNodes.map((region) => ({
    id: region?.id || null,
    provenance: region?.provenance || null,
    confidence: Number(region?.confidence) || 0,
    surfaceTypeCandidate: region?.surfaceTypeCandidate || 'unknown',
    geometry: toGeometryShape(region)
  }));

  return {
    layer: 'region-geometry-truth',
    role: 'geometry-faithful-debug',
    count: items.length,
    items
  };
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

function buildAtomicFragmentOverlay(atomicFragments = []){
  return {
    layer: 'atomic-fragments',
    role: 'segmentation-seed-debug',
    count: atomicFragments.length,
    items: atomicFragments
  };
}

module.exports = {
  buildRegionProposalOverlay,
  buildRegionGeometryOverlay,
  buildRegionGraphOverlay,
  buildTextTokenOverlay,
  buildTextLineOverlay,
  buildTextBlockOverlay,
  buildTextGraphOverlay,
  buildSurfaceCandidateOverlay,
  buildAtomicFragmentOverlay
};
