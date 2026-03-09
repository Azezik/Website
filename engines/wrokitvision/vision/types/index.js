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

function createSelectionSeed({ bbox, polygon, normalized, page, imageRef, fieldMeta } = {}){
  return {
    bbox: ensureBBox(bbox || {}),
    polygon: Array.isArray(polygon) ? polygon : null,
    normalized: normalized || null,
    page: Number(page) || 1,
    imageRef: imageRef || null,
    fieldMeta: fieldMeta || null
  };
}

function createSelectionContext({
  overlappingTokenIds,
  nearestLineIds,
  nearestBlockIds,
  intersectingRegionIds,
  containingRegionIds,
  nearbySurfaceCandidateIds,
  artifactRefs
} = {}){
  return {
    overlappingTokenIds: Array.isArray(overlappingTokenIds) ? overlappingTokenIds : [],
    nearestLineIds: Array.isArray(nearestLineIds) ? nearestLineIds : [],
    nearestBlockIds: Array.isArray(nearestBlockIds) ? nearestBlockIds : [],
    intersectingRegionIds: Array.isArray(intersectingRegionIds) ? intersectingRegionIds : [],
    containingRegionIds: Array.isArray(containingRegionIds) ? containingRegionIds : [],
    nearbySurfaceCandidateIds: Array.isArray(nearbySurfaceCandidateIds) ? nearbySurfaceCandidateIds : [],
    artifactRefs: artifactRefs || {}
  };
}

function createNodeRelevanceScore({ nodeId, nodeType, score, retained, scoreComponents, provenance } = {}){
  return {
    nodeId: nodeId || null,
    nodeType: nodeType || 'unknown',
    score: Number(score) || 0,
    retained: !!retained,
    scoreComponents: scoreComponents || {},
    provenance: provenance || null
  };
}

function createSelectionAssociationResult({ selectionSeed, selectionContext } = {}){
  return {
    selectionSeed: selectionSeed || createSelectionSeed(),
    selectionContext: selectionContext || createSelectionContext()
  };
}

function createResolvedLocalSubgraph({
  selectionSeed,
  selectionContext,
  retainedTextTokenNodes,
  retainedTextLineNodes,
  retainedTextBlockNodes,
  retainedRegionNodes,
  retainedSurfaceCandidates,
  retainedTypedEdges,
  relevanceScores,
  inferredParentChain,
  neighborhoodMeta,
  rejectedNodeIds
} = {}){
  return {
    selectionSeed: selectionSeed || null,
    selectionContext: selectionContext || null,
    retainedTextTokenNodes: Array.isArray(retainedTextTokenNodes) ? retainedTextTokenNodes : [],
    retainedTextLineNodes: Array.isArray(retainedTextLineNodes) ? retainedTextLineNodes : [],
    retainedTextBlockNodes: Array.isArray(retainedTextBlockNodes) ? retainedTextBlockNodes : [],
    retainedRegionNodes: Array.isArray(retainedRegionNodes) ? retainedRegionNodes : [],
    retainedSurfaceCandidates: Array.isArray(retainedSurfaceCandidates) ? retainedSurfaceCandidates : [],
    retainedTypedEdges: Array.isArray(retainedTypedEdges) ? retainedTypedEdges : [],
    relevanceScores: Array.isArray(relevanceScores) ? relevanceScores : [],
    inferredParentChain: Array.isArray(inferredParentChain) ? inferredParentChain : [],
    neighborhoodMeta: neighborhoodMeta || {},
    rejectedNodeIds: Array.isArray(rejectedNodeIds) ? rejectedNodeIds : []
  };
}


function createLocalStructure({
  seed,
  anchorTokenCandidates,
  labelCandidates,
  containingLine,
  containingBlock,
  containingRegionChain,
  siblingNodes,
  neighborhoodRoles,
  structuralConfidence,
  rationale,
  debug
} = {}){
  return {
    schema: 'wrokitvision/local-structure/v1',
    seed: seed || null,
    anchorTokenCandidates: Array.isArray(anchorTokenCandidates) ? anchorTokenCandidates : [],
    labelCandidates: Array.isArray(labelCandidates) ? labelCandidates : [],
    containingLine: containingLine || null,
    containingBlock: containingBlock || null,
    containingRegionChain: Array.isArray(containingRegionChain) ? containingRegionChain : [],
    siblingNodes: siblingNodes || { tokens: [], lines: [], blocks: [], regions: [] },
    neighborhoodRoles: neighborhoodRoles || {},
    structuralConfidence: clamp01(structuralConfidence),
    rationale: rationale || createScoreBreakdown(),
    debug: debug || {}
  };
}

function createLocalCoordinateFrame({
  origin,
  primaryAxis,
  secondaryAxis,
  rotationAngle,
  skew,
  transform,
  rawGeometry,
  confidence,
  rationale,
  evidence,
  debug
} = {}){
  return {
    schema: 'wrokitvision/local-coordinate-frame/v1',
    origin: origin || { x: 0, y: 0 },
    primaryAxis: primaryAxis || { x: 1, y: 0 },
    secondaryAxis: secondaryAxis || { x: 0, y: 1 },
    rotationAngle: Number(rotationAngle) || 0,
    skew: skew || null,
    transform: transform || { toLocal: null, toRaw: null },
    rawGeometry: rawGeometry || {},
    confidence: clamp01(confidence),
    rationale: rationale || createScoreBreakdown(),
    evidence: evidence || {},
    debug: debug || {}
  };
}

function createFieldSignatureComponent({ componentType, nodeId, nodeType, role, text, normalizedText, geometry, relationship, confidence, rationale } = {}){
  return {
    componentType: componentType || 'unknown',
    nodeId: nodeId || null,
    nodeType: nodeType || null,
    role: role || null,
    text: text == null ? null : String(text),
    normalizedText: normalizedText == null ? null : String(normalizedText),
    geometry: geometry || null,
    relationship: relationship || null,
    confidence: clamp01(confidence),
    rationale: rationale || createScoreBreakdown()
  };
}

function createFieldSignature({
  fieldIdentity,
  seed,
  anchorTokens,
  nearbyLabels,
  structuralRelationships,
  containingRegions,
  siblingStructures,
  localGeometry,
  localCoordinateFrame,
  graphRelationships,
  components,
  confidence,
  rationale,
  schemaVersion,
  debug
} = {}){
  return {
    schema: 'wrokitvision/field-signature/v1',
    schemaVersion: Number(schemaVersion) || 1,
    fieldIdentity: fieldIdentity || {},
    seed: seed || null,
    anchorTokens: Array.isArray(anchorTokens) ? anchorTokens : [],
    nearbyLabels: Array.isArray(nearbyLabels) ? nearbyLabels : [],
    structuralRelationships: structuralRelationships || {},
    containingRegions: Array.isArray(containingRegions) ? containingRegions : [],
    siblingStructures: siblingStructures || { lines: [], blocks: [], regions: [] },
    localGeometry: localGeometry || {},
    localCoordinateFrame: localCoordinateFrame || null,
    graphRelationships: Array.isArray(graphRelationships) ? graphRelationships : [],
    components: Array.isArray(components) ? components : [],
    confidence: clamp01(confidence),
    rationale: rationale || createScoreBreakdown(),
    debug: debug || {}
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
  ensureBBox,
  createSelectionSeed,
  createSelectionContext,
  createResolvedLocalSubgraph,
  createSelectionAssociationResult,
  createNodeRelevanceScore,
  createLocalStructure,
  createLocalCoordinateFrame,
  createFieldSignature,
  createFieldSignatureComponent
};
