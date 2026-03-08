'use strict';

function clamp01(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function ensureBBox(bbox){
  const x = Number(bbox?.x) || 0;
  const y = Number(bbox?.y) || 0;
  const w = Math.max(0, Number(bbox?.w) || 0);
  const h = Math.max(0, Number(bbox?.h) || 0);
  return { x, y, w, h };
}

function toPolygonFromBox(bbox){
  const b = ensureBBox(bbox);
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h }
  ];
}

function createScoreBreakdown({ total, components, notes } = {}){
  return {
    total: Number(total) || 0,
    components: Array.isArray(components) ? components : [],
    notes: Array.isArray(notes) ? notes : []
  };
}

function createGraphEdge({ edgeId, sourceNodeId, targetNodeId, edgeType, weight, rationale, provenance } = {}){
  return {
    edgeId: edgeId || null,
    sourceNodeId: sourceNodeId || null,
    targetNodeId: targetNodeId || null,
    edgeType: edgeType || 'unknown',
    weight: clamp01(weight),
    rationale: rationale || createScoreBreakdown(),
    provenance: provenance || { stage: 'unknown' }
  };
}

function createStructuralRegionNode({ id, geometry, confidence, provenance, features, surfaceTypeCandidate, textDensity, orientation } = {}){
  const bbox = ensureBBox(geometry?.bbox || geometry);
  return {
    id,
    nodeType: 'structural_region',
    geometry: {
      bbox,
      polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
      orientation: Number(orientation) || Number(geometry?.orientation) || 0
    },
    confidence: clamp01(confidence),
    provenance: provenance || { stage: 'region-proposals' },
    features: features || {},
    surfaceTypeCandidate: surfaceTypeCandidate || 'unknown',
    textDensity: clamp01(textDensity)
  };
}

function createTextTokenNode({ id, geometry, confidence, provenance, text, normalizedText, ocr, features, parentLineId, parentBlockId } = {}){
  const bbox = ensureBBox(geometry?.bbox || geometry);
  return {
    id,
    nodeType: 'text_token',
    text: String(text || ''),
    normalizedText: String(normalizedText || text || '').trim(),
    geometry: {
      bbox,
      polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
      orientation: Number(geometry?.orientation) || 0
    },
    confidence: clamp01(confidence),
    provenance: provenance || { stage: 'text-detection' },
    ocr: ocr || {},
    features: features || {},
    parentLineId: parentLineId || null,
    parentBlockId: parentBlockId || null
  };
}

function createTextLineNode({ id, geometry, confidence, provenance, tokenIds, text, normalizedText, features, parentBlockId } = {}){
  const bbox = ensureBBox(geometry?.bbox || geometry);
  return {
    id,
    nodeType: 'text_line',
    tokenIds: Array.isArray(tokenIds) ? tokenIds : [],
    text: String(text || ''),
    normalizedText: String(normalizedText || text || '').trim(),
    geometry: {
      bbox,
      polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
      orientation: Number(geometry?.orientation) || 0
    },
    confidence: clamp01(confidence),
    provenance: provenance || { stage: 'text-grouping' },
    features: features || {},
    parentBlockId: parentBlockId || null
  };
}

function createTextBlockNode({ id, geometry, confidence, provenance, lineIds, tokenIds, text, normalizedText, features } = {}){
  const bbox = ensureBBox(geometry?.bbox || geometry);
  return {
    id,
    nodeType: 'text_block',
    lineIds: Array.isArray(lineIds) ? lineIds : [],
    tokenIds: Array.isArray(tokenIds) ? tokenIds : [],
    text: String(text || ''),
    normalizedText: String(normalizedText || text || '').trim(),
    geometry: {
      bbox,
      polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
      orientation: Number(geometry?.orientation) || 0
    },
    confidence: clamp01(confidence),
    provenance: provenance || { stage: 'text-grouping' },
    features: features || {}
  };
}

function createSurfaceCandidate({ id, geometry, confidence, provenance, surfaceType, features, supportingRegionIds } = {}){
  const bbox = ensureBBox(geometry?.bbox || geometry);
  return {
    id,
    nodeType: 'surface_candidate',
    geometry: {
      bbox,
      polygon: Array.isArray(geometry?.polygon) ? geometry.polygon : toPolygonFromBox(bbox),
      orientation: Number(geometry?.orientation) || 0
    },
    confidence: clamp01(confidence),
    provenance: provenance || { stage: 'surface-candidates' },
    surfaceType: surfaceType || 'unknown',
    features: features || {},
    supportingRegionIds: Array.isArray(supportingRegionIds) ? supportingRegionIds : []
  };
}

function createUploadedImageAnalysis({
  analysisId,
  imageRef,
  viewport,
  regionNodes,
  regionGraph,
  textTokens,
  textLines,
  textBlocks,
  textGraph,
  surfaceCandidates,
  debugArtifacts,
  version
} = {}){
  return {
    schema: 'wrokitvision/uploaded-image-analysis/v1',
    version: Number(version) || 1,
    analysisId: analysisId || null,
    generatedAt: Date.now(),
    imageRef: imageRef || null,
    viewport: viewport || null,
    regionNodes: Array.isArray(regionNodes) ? regionNodes : [],
    regionGraph: regionGraph || { nodes: [], edges: [] },
    textTokens: Array.isArray(textTokens) ? textTokens : [],
    textLines: Array.isArray(textLines) ? textLines : [],
    textBlocks: Array.isArray(textBlocks) ? textBlocks : [],
    textGraph: textGraph || { nodes: [], edges: [] },
    surfaceCandidates: Array.isArray(surfaceCandidates) ? surfaceCandidates : [],
    debugArtifacts: debugArtifacts || {}
  };
}

module.exports = {
  createUploadedImageAnalysis,
  createStructuralRegionNode,
  createTextTokenNode,
  createTextLineNode,
  createTextBlockNode,
  createSurfaceCandidate,
  createGraphEdge,
  createScoreBreakdown,
  ensureBBox
};
