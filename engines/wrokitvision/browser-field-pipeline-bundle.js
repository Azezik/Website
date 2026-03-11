/**
 * WrokitVision Browser Field-Pipeline Bundle
 *
 * Exposes window.WrokitVisionFieldPipeline = {
 *   SelectionAssociation, LocalRelevance, LocalSubgraph,
 *   LocalStructure, LocalFrame, FieldMatcher
 * }
 *
 * so wrokit-vision-engine.js can run the full typed selection →
 * relevance → subgraph → structure → frame → signature → match
 * pipeline in the browser, not just in Node.js.
 *
 * All source modules are inlined in dependency order.
 * No external dependencies.
 * Must be loaded BEFORE engines/core/wrokit-vision-engine.js.
 */
(function(root){
  'use strict';

  // ── shared helpers (mirrors vision/types/index.js) ─────────────────────────
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

  function createScoreBreakdown({ total, components, notes } = {}){
    return {
      total: Number(total) || 0,
      components: Array.isArray(components) ? components : [],
      notes: Array.isArray(notes) ? notes : []
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
    overlappingTokenIds, nearestLineIds, nearestBlockIds,
    intersectingRegionIds, containingRegionIds, nearbySurfaceCandidateIds, artifactRefs
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

  function createSelectionAssociationResult({ selectionSeed, selectionContext } = {}){
    return {
      selectionSeed: selectionSeed || createSelectionSeed(),
      selectionContext: selectionContext || createSelectionContext()
    };
  }

  function createResolvedLocalSubgraph({
    selectionSeed, selectionContext, retainedTextTokenNodes, retainedTextLineNodes,
    retainedTextBlockNodes, retainedRegionNodes, retainedSurfaceCandidates, retainedTypedEdges,
    relevanceScores, inferredParentChain, neighborhoodMeta, rejectedNodeIds
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
    seed, anchorTokenCandidates, labelCandidates, containingLine, containingBlock,
    containingRegionChain, siblingNodes, neighborhoodRoles, structuralConfidence, rationale, debug
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
    origin, primaryAxis, secondaryAxis, rotationAngle, skew, transform,
    rawGeometry, confidence, rationale, evidence, debug
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

  function createMatchScoreBreakdown({ totalScore, weightedScore, confidence, signals, weights, rationale, ambiguity } = {}){
    return {
      totalScore: Number(totalScore) || 0,
      weightedScore: Number(weightedScore) || 0,
      confidence: clamp01(confidence),
      signals: signals || {},
      weights: weights || {},
      rationale: rationale || createScoreBreakdown(),
      ambiguity: ambiguity || null
    };
  }

  function createMatchCandidate({
    candidateId, nodeIds, localStructureRefs, regionRef, blockRef, lineRef,
    tokenRefs, localCoordinateComparison, scoreBreakdown, extractedValueCandidates, debug
  } = {}){
    return {
      candidateId: candidateId || null,
      nodeIds: Array.isArray(nodeIds) ? nodeIds : [],
      localStructureRefs: localStructureRefs || {},
      regionRef: regionRef || null,
      blockRef: blockRef || null,
      lineRef: lineRef || null,
      tokenRefs: Array.isArray(tokenRefs) ? tokenRefs : [],
      localCoordinateComparison: localCoordinateComparison || {},
      scoreBreakdown: scoreBreakdown || createMatchScoreBreakdown(),
      extractedValueCandidates: Array.isArray(extractedValueCandidates) ? extractedValueCandidates : [],
      debug: debug || {}
    };
  }

  function createFieldMatchResult({
    fieldKey, selectedCandidate, candidates, extractedValueCandidates,
    value, confidence, rationale, fallback, ambiguity, debug
  } = {}){
    return {
      schema: 'wrokitvision/field-match-result/v1',
      fieldKey: fieldKey || null,
      selectedCandidate: selectedCandidate || null,
      candidates: Array.isArray(candidates) ? candidates : [],
      extractedValueCandidates: Array.isArray(extractedValueCandidates) ? extractedValueCandidates : [],
      value: value == null ? '' : String(value),
      confidence: clamp01(confidence),
      rationale: rationale || createScoreBreakdown(),
      fallback: fallback || null,
      ambiguity: ambiguity || null,
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
    fieldIdentity, seed, anchorTokens, nearbyLabels, structuralRelationships,
    containingRegions, siblingStructures, localGeometry, localCoordinateFrame,
    graphRelationships, components, confidence, rationale, schemaVersion, debug
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

  // ── selection-association/index.js ─────────────────────────────────────────
  function _sa_area(box){ return Math.max(0, box.w) * Math.max(0, box.h); }
  function _sa_center(box){ return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) }; }
  function _sa_intersectionArea(a, b){
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    if(x1 <= x0 || y1 <= y0) return 0;
    return (x1 - x0) * (y1 - y0);
  }
  function _sa_iou(a, b){
    const inter = _sa_intersectionArea(a, b);
    if(inter <= 0) return 0;
    return inter / Math.max(1, _sa_area(a) + _sa_area(b) - inter);
  }
  function _sa_contains(a, b){
    return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
  }
  function _sa_centerDistanceNorm(a, b, viewport){
    const ca = _sa_center(a), cb = _sa_center(b);
    const diag = Math.hypot(Number(viewport?.width) || 1, Number(viewport?.height) || 1) || 1;
    return Math.hypot(ca.x - cb.x, ca.y - cb.y) / diag;
  }
  function _sa_orientationCompatibility(seedNode, candidateNode){
    const sa = Number(seedNode?.orientation) || 0;
    const sb = Number(candidateNode?.geometry?.orientation) || 0;
    const diff = Math.abs(sa - sb);
    return Math.max(0, 1 - (Math.min(180, diff) / 180));
  }
  function _sa_selectIds(nodes, predicate){
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

    const overlapsTokenIds = _sa_selectIds(tokenNodes, n => _sa_intersectionArea(seedBox, ensureBBox(n?.geometry?.bbox)) > 0);
    const nearestLineIds = lineNodes
      .map(n => ({ id: n.id, d: _sa_centerDistanceNorm(seedBox, ensureBBox(n?.geometry?.bbox), viewport) }))
      .sort((a, b) => a.d - b.d).slice(0, 8).map(x => x.id).filter(Boolean);
    const nearestBlockIds = blockNodes
      .map(n => ({ id: n.id, d: _sa_centerDistanceNorm(seedBox, ensureBBox(n?.geometry?.bbox), viewport) }))
      .sort((a, b) => a.d - b.d).slice(0, 6).map(x => x.id).filter(Boolean);
    const intersectingRegionIds = _sa_selectIds(regionNodes, n => _sa_intersectionArea(seedBox, ensureBBox(n?.geometry?.bbox)) > 0);
    const containingRegionIds = _sa_selectIds(regionNodes, n => _sa_contains(ensureBBox(n?.geometry?.bbox), seedBox));
    const nearbySurfaceCandidateIds = surfaceNodes
      .map(n => {
        const bbox = ensureBBox(n?.geometry?.bbox);
        const signal = (_sa_iou(seedBox, bbox) * 0.6)
          + ((1 - _sa_centerDistanceNorm(seedBox, bbox, viewport)) * 0.25)
          + (_sa_orientationCompatibility(seedLikeNode, n) * 0.15);
        return { id: n.id, signal };
      })
      .filter(item => item.signal > 0.05)
      .sort((a, b) => b.signal - a.signal)
      .slice(0, 6).map(item => item.id).filter(Boolean);

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

  // ── resolution/local-relevance/index.js ───────────────────────────────────
  function _lr_area(box){ return Math.max(0, box.w) * Math.max(0, box.h); }
  function _lr_center(box){ return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) }; }
  function _lr_intersectionArea(a, b){
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    if(x1 <= x0 || y1 <= y0) return 0;
    return (x1 - x0) * (y1 - y0);
  }
  function _lr_iou(a, b){
    const inter = _lr_intersectionArea(a, b);
    if(inter <= 0) return 0;
    return inter / Math.max(1, _lr_area(a) + _lr_area(b) - inter);
  }
  function _lr_distanceSignal(seedBox, box, viewport){
    const c1 = _lr_center(seedBox), c2 = _lr_center(box);
    const diag = Math.max(1, Math.hypot(Number(viewport?.width) || 1, Number(viewport?.height) || 1));
    return Math.max(0, 1 - Math.hypot(c1.x - c2.x, c1.y - c2.y) / diag);
  }
  function _lr_contains(a, b){
    return a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.h) >= (b.y + b.h);
  }
  function _lr_normalizeAngleDeg(angle){
    const n = Number(angle);
    if(!Number.isFinite(n)) return null;
    return ((n % 360) + 360) % 360;
  }
  function _lr_smallestAngularDiff(a, b){
    const an = _lr_normalizeAngleDeg(a), bn = _lr_normalizeAngleDeg(b);
    if(an == null || bn == null) return null;
    const diff = Math.abs(an - bn);
    return Math.min(diff, 360 - diff);
  }
  function _lr_estimateSeedOrientation({ selectionContext, lineById, blockById } = {}){
    const lineAngles = (selectionContext?.nearestLineIds || [])
      .map(id => lineById.get(id))
      .map(n => _lr_normalizeAngleDeg(n?.geometry?.orientation))
      .filter(v => v != null);
    if(lineAngles.length) return { orientation: lineAngles.reduce((s, v) => s + v, 0) / lineAngles.length, source: 'nearest_lines' };
    const blockAngles = (selectionContext?.nearestBlockIds || [])
      .map(id => blockById.get(id))
      .map(n => _lr_normalizeAngleDeg(n?.geometry?.orientation))
      .filter(v => v != null);
    if(blockAngles.length) return { orientation: blockAngles.reduce((s, v) => s + v, 0) / blockAngles.length, source: 'nearest_blocks' };
    return { orientation: null, source: 'unavailable' };
  }
  function _lr_orientationSignal(seedOrientation, candidateOrientation){
    const angularDifference = _lr_smallestAngularDiff(seedOrientation, candidateOrientation);
    if(angularDifference == null) return { score: 0.5, angularDifference: null, source: 'fallback-neutral' };
    return { score: Math.max(0, 1 - (angularDifference / 180)), angularDifference, source: 'orientation-angle' };
  }
  function _lr_scoreNode({ node, nodeType, seedBox, viewport, selectionContext, lineById, blockById, regionById, seedOrientationMeta } = {}){
    const box = ensureBBox(node?.geometry?.bbox || {});
    const overlap = _lr_iou(seedBox, box);
    const distance = _lr_distanceSignal(seedBox, box, viewport);
    const containment = _lr_contains(seedBox, box) || _lr_contains(box, seedBox) ? 1 : 0;
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
        return regionById.get(node.id) ? 0.5 : 0;
      }
      return 0;
    })();
    const alignMeta = _lr_orientationSignal(seedOrientationMeta?.orientation, node?.geometry?.orientation);
    const provenance = Number(node?.provenance?.weight) || 0.5;
    const confidence = Number(node?.confidence);
    const textConfidence = Number.isFinite(confidence) ? confidence : 0.5;
    const components = { overlap, distance, containment, sharedParentRegion, topology: Math.max(0, Math.min(1, topology)), adjacency, alignment: alignMeta.score, alignmentAngleDelta: alignMeta.angularDifference, alignmentSource: alignMeta.source, seedOrientation: seedOrientationMeta?.orientation, provenance, textConfidence };
    const weights = { overlap: 0.26, distance: 0.2, containment: 0.12, sharedParentRegion: 0.1, topology: 0.14, adjacency: 0.08, alignment: 0.04, provenance: 0.03, textConfidence: 0.03 };
    let total = 0;
    Object.keys(weights).forEach(key => { total += (components[key] || 0) * weights[key]; });
    return createNodeRelevanceScore({ nodeId: node.id, nodeType, score: total, retained: total >= 0.22, scoreComponents: components, provenance: node?.provenance || null });
  }

  function scoreLocalRelevance({ canonicalPrecomputed, selectionSeed, selectionContext } = {}){
    const analysis = canonicalPrecomputed?.uploadedImageAnalysis || {};
    const seedBox = ensureBBox(selectionSeed?.bbox || {});
    const viewport = analysis.viewport || null;
    const lineById = new Map((analysis.textLines || []).map(n => [n.id, n]));
    const blockById = new Map((analysis.textBlocks || []).map(n => [n.id, n]));
    const regionById = new Map((analysis.regionNodes || []).map(n => [n.id, n]));
    const seedOrientationMeta = _lr_estimateSeedOrientation({ selectionContext, lineById, blockById });
    const allScores = [];
    const gather = (nodes, nodeType) => {
      (Array.isArray(nodes) ? nodes : []).forEach(node => {
        allScores.push(_lr_scoreNode({ node, nodeType, seedBox, viewport, selectionContext, lineById, blockById, regionById, seedOrientationMeta }));
      });
    };
    gather(analysis.textTokens, 'text_token');
    gather(analysis.textLines, 'text_line');
    gather(analysis.textBlocks, 'text_block');
    gather(analysis.regionNodes, 'structural_region');
    gather(analysis.surfaceCandidates, 'surface_candidate');
    allScores.sort((a, b) => b.score - a.score);
    return { nodeScores: allScores, retainedNodeIds: allScores.filter(s => s.retained).map(s => s.nodeId), rejectedNodeIds: allScores.filter(s => !s.retained).map(s => s.nodeId) };
  }

  // ── resolution/local-subgraph/index.js ────────────────────────────────────
  function _ls_pickNodes(nodes, retainedIds){
    const kept = [], rejected = [];
    const retained = new Set(retainedIds || []);
    (Array.isArray(nodes) ? nodes : []).forEach(node => {
      if(retained.has(node.id)) kept.push(node); else rejected.push(node.id);
    });
    return { kept, rejected };
  }
  function _ls_buildParentChains({ tokens = [], lines = [], blocks = [] } = {}){
    const lineById = new Map(lines.map(n => [n.id, n]));
    const blockById = new Map(blocks.map(n => [n.id, n]));
    return tokens.map(tok => ({
      tokenId: tok.id,
      lineId: tok.parentLineId || null,
      blockId: tok.parentBlockId || (tok.parentLineId ? lineById.get(tok.parentLineId)?.parentBlockId || null : null),
      blockNodePresent: !!(tok.parentBlockId && blockById.get(tok.parentBlockId))
    }));
  }

  function resolveLocalSubgraph({ canonicalPrecomputed, associationResult, relevanceResult } = {}){
    const analysis = canonicalPrecomputed?.uploadedImageAnalysis || {};
    const retained = relevanceResult?.retainedNodeIds || [];
    const tokens = _ls_pickNodes(analysis.textTokens, retained);
    const lines = _ls_pickNodes(analysis.textLines, retained);
    const blocks = _ls_pickNodes(analysis.textBlocks, retained);
    const regions = _ls_pickNodes(analysis.regionNodes, retained);
    const surfaces = _ls_pickNodes(analysis.surfaceCandidates, retained);
    const keptSet = new Set(retained);
    const textEdges = (analysis.textGraph?.edges || []).filter(edge => keptSet.has(edge.sourceNodeId) || keptSet.has(edge.targetNodeId));
    const regionEdges = (analysis.regionGraph?.edges || []).filter(edge => keptSet.has(edge.sourceNodeId) || keptSet.has(edge.targetNodeId));
    const synthesizedSurfaceEdges = surfaces.kept.flatMap(surface => {
      const support = Array.isArray(surface.supportingRegionIds) ? surface.supportingRegionIds : [];
      return support.filter(regionId => keptSet.has(regionId)).map((regionId, index) => ({
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
      rejectedNodeIds: [...tokens.rejected, ...lines.rejected, ...blocks.rejected, ...regions.rejected, ...surfaces.rejected],
      inferredParentChain: _ls_buildParentChains({ tokens: tokens.kept, lines: lines.kept, blocks: blocks.kept }),
      neighborhoodMeta: { retainedNodeCount: retained.length, retainedEdgeCount: textEdges.length + regionEdges.length + synthesizedSurfaceEdges.length }
    });
  }

  // ── resolution/local-structure/index.js ───────────────────────────────────
  function _lst_center(box){ return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) }; }
  function _lst_distance(a, b){ return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0)); }
  function _lst_inferContainingRegions({ seedBox, regions = [] } = {}){
    return regions
      .filter(region => {
        const box = region?.geometry?.bbox || {};
        return box.x <= seedBox.x && box.y <= seedBox.y && (box.x + box.w) >= (seedBox.x + seedBox.w) && (box.y + box.h) >= (seedBox.y + seedBox.h);
      })
      .sort((a, b) => ((a?.geometry?.bbox?.w || 0) * (a?.geometry?.bbox?.h || 0)) - ((b?.geometry?.bbox?.w || 0) * (b?.geometry?.bbox?.h || 0)))
      .map(region => ({ nodeId: region.id, nodeType: region.nodeType, geometry: region.geometry, orientation: Number(region?.geometry?.orientation) || 0, confidence: Number(region?.confidence) || 0 }));
  }
  function _lst_buildRoleHints({ tokens = [], lines = [], blocks = [], regions = [] } = {}){
    const tokenIds = new Set(tokens.map(t => t.id));
    const lineIds = new Set(lines.map(l => l.id));
    return {
      tokenRoleById: tokens.reduce((acc, t) => { acc[t.id] = tokenIds.size === 1 ? 'seed-anchor' : 'local-anchor-candidate'; return acc; }, {}),
      lineRoleById: lines.reduce((acc, l) => { acc[l.id] = lineIds.size === 1 ? 'seed-line' : 'sibling-line'; return acc; }, {}),
      blockRoleById: blocks.reduce((acc, b, i) => { acc[b.id] = i === 0 ? 'containing-block-candidate' : 'sibling-block-candidate'; return acc; }, {}),
      regionRoleById: regions.reduce((acc, r, i) => { acc[r.id] = i === 0 ? 'closest-region-candidate' : 'nearby-region-candidate'; return acc; }, {})
    };
  }

  function reconstructLocalStructure({ resolvedLocalSubgraph } = {}){
    const seed = resolvedLocalSubgraph?.selectionSeed || null;
    const seedBox = seed?.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const seedCenter = _lst_center(seedBox);
    const tokens = Array.isArray(resolvedLocalSubgraph?.retainedTextTokenNodes) ? resolvedLocalSubgraph.retainedTextTokenNodes : [];
    const lines = Array.isArray(resolvedLocalSubgraph?.retainedTextLineNodes) ? resolvedLocalSubgraph.retainedTextLineNodes : [];
    const blocks = Array.isArray(resolvedLocalSubgraph?.retainedTextBlockNodes) ? resolvedLocalSubgraph.retainedTextBlockNodes : [];
    const regions = Array.isArray(resolvedLocalSubgraph?.retainedRegionNodes) ? resolvedLocalSubgraph.retainedRegionNodes : [];
    const anchorTokenCandidates = tokens
      .map(token => {
        const d = _lst_distance(seedCenter, _lst_center(token?.geometry?.bbox || {}));
        return { nodeId: token.id, text: token.text || '', normalizedText: token.normalizedText || '', parentLineId: token.parentLineId || null, parentBlockId: token.parentBlockId || null, geometry: token.geometry || null, confidence: Number(token?.confidence) || 0, score: 1 / (1 + d) };
      })
      .sort((a, b) => b.score - a.score).slice(0, 8);
    const lineById = new Map(lines.map(line => [line.id, line]));
    const labelCandidates = lines
      .map(line => {
        const lc = String(line?.normalizedText || line?.text || '').toLowerCase();
        const hasLabelCue = /invoice|date|total|amount|tax|vendor|seller|company|bill to|sold to|customer|subtotal|discount/.test(lc) ? 1 : 0;
        const d = _lst_distance(seedCenter, _lst_center(line?.geometry?.bbox || {}));
        return { nodeId: line.id, lineText: line.text || '', normalizedText: line.normalizedText || '', geometry: line.geometry || null, score: (hasLabelCue * 0.65) + ((1 / (1 + d)) * 0.35), labelCue: !!hasLabelCue };
      })
      .sort((a, b) => b.score - a.score).slice(0, 5);
    const containingLine = anchorTokenCandidates[0]?.parentLineId ? lineById.get(anchorTokenCandidates[0].parentLineId) || null : null;
    const containingBlock = containingLine?.parentBlockId
      ? (blocks.find(b => b.id === containingLine.parentBlockId) || null)
      : (anchorTokenCandidates[0]?.parentBlockId ? (blocks.find(b => b.id === anchorTokenCandidates[0].parentBlockId) || null) : null);
    const containingRegionChain = _lst_inferContainingRegions({ seedBox, regions });
    const siblingLines = lines.filter(l => containingLine && l.id !== containingLine.id).slice(0, 10);
    const siblingBlocks = blocks.filter(b => containingBlock && b.id !== containingBlock.id).slice(0, 6);
    const siblingRegions = regions.filter(r => !containingRegionChain.some(c => c.nodeId === r.id)).slice(0, 10);
    const rowTendencyScore = (() => {
      if(!containingLine) return 0;
      const refY = (containingLine.geometry?.bbox?.y || 0) + ((containingLine.geometry?.bbox?.h || 0) / 2);
      const closeY = siblingLines.filter(l => { const y = (l.geometry?.bbox?.y || 0) + ((l.geometry?.bbox?.h || 0) / 2); return Math.abs(y - refY) <= Math.max(8, containingLine.geometry?.bbox?.h || 0); }).length;
      return Math.min(1, closeY / Math.max(1, siblingLines.length || 1));
    })();
    const columnTendencyScore = (() => {
      if(!containingLine) return 0;
      const refX = (containingLine.geometry?.bbox?.x || 0) + ((containingLine.geometry?.bbox?.w || 0) / 2);
      const closeX = siblingLines.filter(l => { const x = (l.geometry?.bbox?.x || 0) + ((l.geometry?.bbox?.w || 0) / 2); return Math.abs(x - refX) <= Math.max(20, (containingLine.geometry?.bbox?.w || 0) * 0.25); }).length;
      return Math.min(1, closeX / Math.max(1, siblingLines.length || 1));
    })();
    const structuralConfidence = Math.max(0.2, Math.min(0.98, (anchorTokenCandidates.length ? 0.3 : 0) + (containingLine ? 0.22 : 0) + (containingBlock ? 0.16 : 0) + (containingRegionChain.length ? 0.18 : 0) + (labelCandidates.length ? 0.14 : 0)));
    return createLocalStructure({
      seed,
      anchorTokenCandidates,
      labelCandidates,
      containingLine: containingLine ? { nodeId: containingLine.id, text: containingLine.text || '', geometry: containingLine.geometry || null, orientation: Number(containingLine?.geometry?.orientation) || 0 } : null,
      containingBlock: containingBlock ? { nodeId: containingBlock.id, text: containingBlock.text || '', geometry: containingBlock.geometry || null, orientation: Number(containingBlock?.geometry?.orientation) || 0 } : null,
      containingRegionChain,
      siblingNodes: {
        tokens: anchorTokenCandidates.slice(1),
        lines: siblingLines.map(l => ({ nodeId: l.id, text: l.text || '', geometry: l.geometry || null })),
        blocks: siblingBlocks.map(b => ({ nodeId: b.id, text: b.text || '', geometry: b.geometry || null })),
        regions: siblingRegions.map(r => ({ nodeId: r.id, geometry: r.geometry || null, confidence: Number(r?.confidence) || 0 }))
      },
      neighborhoodRoles: { ..._lst_buildRoleHints({ tokens, lines, blocks, regions }), rowTendencyScore, columnTendencyScore },
      structuralConfidence,
      rationale: createScoreBreakdown({ total: structuralConfidence, components: [{ key: 'anchorTokenCandidates', value: anchorTokenCandidates.length }, { key: 'labelCandidates', value: labelCandidates.length }, { key: 'containingLinePresent', value: containingLine ? 1 : 0 }, { key: 'containingBlockPresent', value: containingBlock ? 1 : 0 }, { key: 'containingRegionDepth', value: containingRegionChain.length }, { key: 'rowTendencyScore', value: rowTendencyScore }, { key: 'columnTendencyScore', value: columnTendencyScore }], notes: ['local-structure-built-from-resolved-subgraph'] }),
      debug: { retainedNodeCounts: { tokens: tokens.length, lines: lines.length, blocks: blocks.length, regions: regions.length } }
    });
  }

  // ── geometry/local-frame/index.js ──────────────────────────────────────────
  function _lf_normalizeVector(v){ const mag = Math.hypot(Number(v?.x) || 0, Number(v?.y) || 0); if(mag <= 1e-9) return { x: 1, y: 0 }; return { x: (Number(v?.x) || 0) / mag, y: (Number(v?.y) || 0) / mag }; }
  function _lf_perpendicular(v){ return { x: -v.y, y: v.x }; }
  function _lf_angleToVector(angleDeg){ const rad = (Number(angleDeg) || 0) * (Math.PI / 180); return _lf_normalizeVector({ x: Math.cos(rad), y: Math.sin(rad) }); }
  function _lf_normalizeAngleDeg(angle){ const n = Number(angle); if(!Number.isFinite(n)) return null; return ((n % 360) + 360) % 360; }
  function _lf_circularMeanAngleDeg(angles){
    const normalized = (Array.isArray(angles) ? angles : []).map(v => _lf_normalizeAngleDeg(v)).filter(v => v != null);
    if(!normalized.length) return null;
    const vs = normalized.reduce((acc, a) => { const r = a * Math.PI / 180; acc.sin += Math.sin(r); acc.cos += Math.cos(r); return acc; }, { sin: 0, cos: 0 });
    const ms = vs.sin / normalized.length, mc = vs.cos / normalized.length;
    if(Math.abs(ms) < 1e-9 && Math.abs(mc) < 1e-9) return normalized[0];
    return _lf_normalizeAngleDeg(Math.atan2(ms, mc) * (180 / Math.PI));
  }

  function estimateLocalCoordinateFrame({ resolvedLocalSubgraph, localStructure } = {}){
    const seed = resolvedLocalSubgraph?.selectionSeed || null;
    const seedBox = seed?.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const lineAngles = (Array.isArray(resolvedLocalSubgraph?.retainedTextLineNodes) ? resolvedLocalSubgraph.retainedTextLineNodes : []).map(l => _lf_normalizeAngleDeg(l?.geometry?.orientation)).filter(v => v != null);
    const regionAngles = (Array.isArray(resolvedLocalSubgraph?.retainedRegionNodes) ? resolvedLocalSubgraph.retainedRegionNodes : []).map(r => _lf_normalizeAngleDeg(r?.geometry?.orientation)).filter(v => v != null);
    let rotationAngle = 0, evidenceSource = 'fallback-seed-axis';
    if(lineAngles.length){ rotationAngle = _lf_circularMeanAngleDeg(lineAngles); evidenceSource = 'text-line-orientation'; }
    else if(localStructure?.containingBlock?.orientation != null){ rotationAngle = Number(localStructure.containingBlock.orientation) || 0; evidenceSource = 'containing-block-orientation'; }
    else if(regionAngles.length){ rotationAngle = _lf_circularMeanAngleDeg(regionAngles); evidenceSource = 'region-orientation'; }
    const primaryAxis = _lf_angleToVector(rotationAngle);
    const secondaryAxis = _lf_normalizeVector(_lf_perpendicular(primaryAxis));
    const origin = { x: seedBox.x + (seedBox.w / 2), y: seedBox.y + (seedBox.h / 2) };
    const transform = {
      toLocalMatrix: [[primaryAxis.x, primaryAxis.y, -((origin.x * primaryAxis.x) + (origin.y * primaryAxis.y))], [secondaryAxis.x, secondaryAxis.y, -((origin.x * secondaryAxis.x) + (origin.y * secondaryAxis.y))], [0, 0, 1]],
      toRawMatrix: [[primaryAxis.x, secondaryAxis.x, origin.x], [primaryAxis.y, secondaryAxis.y, origin.y], [0, 0, 1]],
      helper: 'x_local = dot((x_raw-origin), primaryAxis); y_local = dot((x_raw-origin), secondaryAxis)'
    };
    const confidence = Math.max(0.2, Math.min(0.98, (lineAngles.length ? 0.62 : 0) + (localStructure?.containingBlock?.orientation != null ? 0.2 : 0) + (regionAngles.length ? 0.1 : 0) + 0.08));
    return createLocalCoordinateFrame({
      origin, primaryAxis, secondaryAxis, rotationAngle, skew: null, transform,
      rawGeometry: { selectionBox: seedBox, containingLine: localStructure?.containingLine?.geometry || null, containingBlock: localStructure?.containingBlock?.geometry || null },
      confidence,
      rationale: createScoreBreakdown({ total: confidence, components: [{ key: 'lineOrientationEvidenceCount', value: lineAngles.length }, { key: 'regionOrientationEvidenceCount', value: regionAngles.length }, { key: 'evidenceSource', value: evidenceSource }], notes: ['local-coordinate-frame-estimated-from-structural-orientation'] }),
      evidence: { source: evidenceSource, lineAngles, regionAngles },
      debug: { rotationAngle, seedCenter: origin }
    });
  }

  // ── matching/candidate-ranking/index.js ───────────────────────────────────
  function _cr_clamp01(v){ const n = Number(v); if(!Number.isFinite(n)) return 0; return Math.max(0, Math.min(1, n)); }
  function _cr_normalizeText(t){ return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function _cr_tokensFromLine(line, tokenMap){ if(!line) return []; return (line.tokenIds || []).map(id => tokenMap.get(id)).filter(Boolean); }
  function _cr_jaccardText(a, b){
    const aa = new Set(_cr_normalizeText(a).split(/\s+/g).filter(Boolean));
    const bb = new Set(_cr_normalizeText(b).split(/\s+/g).filter(Boolean));
    if(!aa.size || !bb.size) return 0;
    let inter = 0; for(const t of aa) if(bb.has(t)) inter++;
    const union = aa.size + bb.size - inter;
    return union > 0 ? inter / union : 0;
  }
  function _cr_safeBBox(box){ return { x: Number(box?.x) || 0, y: Number(box?.y) || 0, w: Math.max(0, Number(box?.w) || 0), h: Math.max(0, Number(box?.h) || 0) }; }
  function _cr_center(box){ const b = _cr_safeBBox(box); return { x: b.x + (b.w / 2), y: b.y + (b.h / 2) }; }
  function _cr_normalizedPointInBox(point, box){ const b = _cr_safeBBox(box); if(!b.w || !b.h) return null; return { x: _cr_clamp01((point.x - b.x) / b.w), y: _cr_clamp01((point.y - b.y) / b.h) }; }
  function _cr_geometrySimilarity(a, b, viewport = {}){
    if(!a || !b) return 0;
    const boxA = _cr_safeBBox(a), boxB = _cr_safeBBox(b);
    const vpW = Math.max(1, Number(viewport.width) || 1), vpH = Math.max(1, Number(viewport.height) || 1);
    const sizeX = 1 - (Math.abs(boxA.w - boxB.w) / Math.max(1, boxA.w, boxB.w));
    const sizeY = 1 - (Math.abs(boxA.h - boxB.h) / Math.max(1, boxA.h, boxB.h));
    const ratioA = boxA.h > 0 ? boxA.w / boxA.h : 0, ratioB = boxB.h > 0 ? boxB.w / boxB.h : 0;
    const ratio = ratioA > 0 && ratioB > 0 ? 1 - (Math.abs(ratioA - ratioB) / Math.max(1, ratioA, ratioB)) : 0;
    const dist = Math.hypot((_cr_center(boxA).x - _cr_center(boxB).x) / vpW, (_cr_center(boxA).y - _cr_center(boxB).y) / vpH);
    return _cr_clamp01((_cr_clamp01(sizeX) * 0.25) + (_cr_clamp01(sizeY) * 0.25) + (_cr_clamp01(ratio) * 0.2) + (_cr_clamp01(1 - dist) * 0.3));
  }
  function _cr_histogram(values = []){ const counts = {}; for(const v of values){ if(!v) continue; counts[v] = (counts[v] || 0) + 1; } const total = Object.values(counts).reduce((s, n) => s + n, 0); if(!total) return {}; Object.keys(counts).forEach(k => { counts[k] = counts[k] / total; }); return counts; }
  function _cr_distributionSimilarity(a = {}, b = {}){ const keys = new Set([...Object.keys(a), ...Object.keys(b)]); if(!keys.size) return 0.5; let overlap = 0; for(const k of keys) overlap += Math.min(Number(a[k]) || 0, Number(b[k]) || 0); return _cr_clamp01(overlap); }
  function _cr_buildLocalGraphProfile({ candidate, analysis } = {}){
    const nodeIds = new Set(candidate?.nodeIds || []);
    for(const id of candidate?.lineRef?.tokenIds || []) nodeIds.add(id);
    for(const id of candidate?.blockRef?.lineIds || []) nodeIds.add(id);
    const textEdges = analysis?.textGraph?.edges || [];
    const regionEdges = analysis?.regionGraph?.edges || [];
    const edges = [...textEdges, ...regionEdges].filter(e => nodeIds.has(e.sourceNodeId) || nodeIds.has(e.targetNodeId));
    return { edgeCount: edges.length, nodeCount: nodeIds.size, edgeDensity: nodeIds.size ? (edges.length / nodeIds.size) : 0, edgeTypeDistribution: _cr_histogram(edges.map(e => e.edgeType)) };
  }
  function _cr_graphRelationshipSimilarity({ signatureRelationships, candidate, analysis } = {}){
    const sigEdges = Array.isArray(signatureRelationships) ? signatureRelationships : [];
    const sigDistribution = _cr_histogram(sigEdges.map(e => e?.edgeType));
    const sigNodes = new Set(); for(const e of sigEdges){ if(e?.sourceNodeId) sigNodes.add(e.sourceNodeId); if(e?.targetNodeId) sigNodes.add(e.targetNodeId); }
    const sigDensity = sigNodes.size ? (sigEdges.length / sigNodes.size) : 0;
    const candidateProfile = _cr_buildLocalGraphProfile({ candidate, analysis });
    const typedPatternSimilarity = _cr_distributionSimilarity(sigDistribution, candidateProfile.edgeTypeDistribution);
    const densitySimilarity = (sigDensity || candidateProfile.edgeDensity) ? _cr_clamp01(1 - (Math.abs(sigDensity - candidateProfile.edgeDensity) / Math.max(1, sigDensity, candidateProfile.edgeDensity))) : 0.5;
    return { score: _cr_clamp01((typedPatternSimilarity * 0.7) + (densitySimilarity * 0.3)), details: { signature: { edgeCount: sigEdges.length, nodeCount: sigNodes.size, edgeDensity: sigDensity, edgeTypeDistribution: sigDistribution }, candidate: candidateProfile, typedPatternSimilarity, densitySimilarity } };
  }

  function rankCandidates({ fieldSignature, candidates, analysis } = {}){
    const tokenMap = new Map((analysis?.textTokens || []).map(t => [t.id, t]));
    const regionMap = new Map((analysis?.regionNodes || []).map(r => [r.id, r]));
    const weights = { anchorTextSimilarity: 0.2, nearbyLabelSimilarity: 0.17, structuralSimilarity: 0.14, containingRegionSimilarity: 0.1, siblingArrangementSimilarity: 0.1, localGeometrySimilarity: 0.17, graphRelationshipSimilarity: 0.12 };
    const ranked = (Array.isArray(candidates) ? candidates : []).map(candidate => {
      const line = candidate.lineRef, block = candidate.blockRef;
      const region = candidate.regionRef || regionMap.get(candidate.localStructureRefs?.regionId) || null;
      const lineTokens = _cr_tokensFromLine(line, tokenMap);
      const lineText = line?.text || lineTokens.map(t => t.text).join(' ');
      const anchorNorms = (fieldSignature?.anchorTokens || []).map(a => _cr_normalizeText(a.normalizedText || a.text));
      const lineNorm = _cr_normalizeText(lineText);
      const anchorTextSimilarity = anchorNorms.length ? anchorNorms.reduce((m, a) => Math.max(m, a && lineNorm ? (lineNorm.includes(a) || a.includes(lineNorm) ? 1 : _cr_jaccardText(a, lineNorm)) : 0), 0) : 0;
      const labelNorms = (fieldSignature?.nearbyLabels || []).map(l => _cr_normalizeText(l.normalizedText || l.text));
      const nearbyLabelSimilarity = labelNorms.length ? labelNorms.reduce((m, l) => Math.max(m, l && lineNorm ? _cr_jaccardText(l, lineNorm) : 0), 0) : 0;
      const sigLineText = fieldSignature?.structuralRelationships?.containingLine?.text || '';
      const sigBlockText = fieldSignature?.structuralRelationships?.containingBlock?.text || '';
      const lineTextSimilarity = sigLineText && lineText ? _cr_jaccardText(sigLineText, lineText) : 0;
      const blockTextSimilarity = sigBlockText && block?.text ? _cr_jaccardText(sigBlockText, block.text) : 0;
      const sigLineBox = fieldSignature?.localGeometry?.localStructure?.containingLineBBox || null;
      const sigBlockBox = fieldSignature?.localGeometry?.localStructure?.containingBlockBBox || null;
      const candLineBox = line?.geometry?.bbox || null, candBlockBox = block?.geometry?.bbox || null;
      let relativePlacementSimilarity = 0;
      if(sigLineBox && sigBlockBox && candLineBox && candBlockBox){
        const sigRel = _cr_normalizedPointInBox(_cr_center(sigLineBox), sigBlockBox);
        const candRel = _cr_normalizedPointInBox(_cr_center(candLineBox), candBlockBox);
        if(sigRel && candRel) relativePlacementSimilarity = _cr_clamp01(1 - Math.hypot(sigRel.x - candRel.x, sigRel.y - candRel.y));
      }
      const structuralSimilarity = _cr_clamp01((lineTextSimilarity * 0.45) + (blockTextSimilarity * 0.25) + (relativePlacementSimilarity * 0.3));
      const sigCenter = fieldSignature?.seed?.bbox ? { x: (Number(fieldSignature.seed.bbox.x) || 0) + ((Number(fieldSignature.seed.bbox.w) || 0) / 2), y: (Number(fieldSignature.seed.bbox.y) || 0) + ((Number(fieldSignature.seed.bbox.h) || 0) / 2) } : null;
      const candBox = line?.geometry?.bbox || block?.geometry?.bbox || region?.geometry?.bbox || null;
      const candCenter = candBox ? { x: (candBox.x || 0) + ((candBox.w || 0) / 2), y: (candBox.y || 0) + ((candBox.h || 0) / 2) } : null;
      const sigRegion = fieldSignature?.containingRegions?.[0] || null;
      const sigRegionBox = sigRegion?.geometry?.bbox || null, candRegionBox = region?.geometry?.bbox || null;
      const regionGeometrySimilarity = _cr_geometrySimilarity(sigRegionBox, candRegionBox, analysis?.viewport || {});
      let regionPlacementSimilarity = 0, regionLineRelationSimilarity = 0;
      if(sigRegionBox && candRegionBox && sigCenter && candCenter){
        const sigSeedRel = _cr_normalizedPointInBox(sigCenter, sigRegionBox), candRel = _cr_normalizedPointInBox(candCenter, candRegionBox);
        if(sigSeedRel && candRel) regionPlacementSimilarity = _cr_clamp01(1 - Math.hypot(sigSeedRel.x - candRel.x, sigSeedRel.y - candRel.y));
      }
      if(sigRegionBox && candRegionBox && sigLineBox && candLineBox){
        const sigLineRel = _cr_normalizedPointInBox(_cr_center(sigLineBox), sigRegionBox), candLineRel = _cr_normalizedPointInBox(_cr_center(candLineBox), candRegionBox);
        if(sigLineRel && candLineRel) regionLineRelationSimilarity = _cr_clamp01(1 - Math.hypot(sigLineRel.x - candLineRel.x, sigLineRel.y - candLineRel.y));
      }
      const containingRegionSimilarity = _cr_clamp01((regionGeometrySimilarity * 0.4) + (regionPlacementSimilarity * 0.4) + (regionLineRelationSimilarity * 0.2));
      const sigSiblingLines = fieldSignature?.siblingStructures?.lines?.length || 0;
      const candSiblingLines = candidate.localStructureRefs?.siblingLineCount || 0;
      const siblingArrangementSimilarity = sigSiblingLines || candSiblingLines ? _cr_clamp01(1 - (Math.abs(sigSiblingLines - candSiblingLines) / Math.max(1, sigSiblingLines, candSiblingLines))) : 0.5;
      const vpW = Number(analysis?.viewport?.width || 1), vpH = Number(analysis?.viewport?.height || 1);
      const localGeometrySimilarity = (sigCenter && candCenter) ? _cr_clamp01(1 - Math.hypot((candCenter.x - sigCenter.x) / vpW, (candCenter.y - sigCenter.y) / vpH)) : 0.4;
      const graphSimilarity = _cr_graphRelationshipSimilarity({ signatureRelationships: fieldSignature?.graphRelationships, candidate, analysis });
      const signals = { anchorTextSimilarity, nearbyLabelSimilarity, structuralSimilarity, containingRegionSimilarity, siblingArrangementSimilarity, localGeometrySimilarity, graphRelationshipSimilarity: graphSimilarity.score };
      const weightedScore = Object.keys(weights).reduce((sum, key) => sum + ((signals[key] || 0) * weights[key]), 0);
      const confidence = _cr_clamp01((weightedScore * 0.92) + 0.05);
      candidate.scoreBreakdown = createMatchScoreBreakdown({ totalScore: weightedScore, weightedScore, confidence, signals, weights, rationale: createScoreBreakdown({ total: weightedScore, components: [...Object.keys(signals).map(k => ({ key: k, value: signals[k] })), { key: 'graphTypedPatternSimilarity', value: graphSimilarity.details.typedPatternSimilarity }, { key: 'graphDensitySimilarity', value: graphSimilarity.details.densitySimilarity }], notes: ['candidate-ranked-using-text-structure-geometry-graph-cues'] }) });
      candidate.debug = { ...(candidate.debug || {}), structuralSimilarity: { lineTextSimilarity, blockTextSimilarity, relativePlacementSimilarity }, containingRegionSimilarity: { regionGeometrySimilarity, regionPlacementSimilarity, regionLineRelationSimilarity }, graphRelationshipSimilarity: graphSimilarity.details };
      return candidate;
    }).sort((a, b) => (b.scoreBreakdown?.weightedScore || 0) - (a.scoreBreakdown?.weightedScore || 0));
    return { ranked, debug: { candidateCount: ranked.length, weights } };
  }

  // ── matching/field-matcher/index.js ───────────────────────────────────────
  function _fm_normalizeText(t){ return String(t || '').replace(/\s+/g, ' ').trim(); }
  function _fm_valueCandidatesFromCandidate(candidate){
    const line = candidate?.lineRef;
    if(!line) return [];
    return [{ text: _fm_normalizeText(line.text), normalizedText: _fm_normalizeText(line.normalizedText || line.text).toLowerCase(), source: 'line-text', lineId: line.id, tokenIds: line.tokenIds || [] }].filter(item => !!item.text);
  }
  function buildCandidates({ fieldSignature, canonicalPrecomputed } = {}){
    const analysis = canonicalPrecomputed?.uploadedImageAnalysis;
    if(!analysis) return [];
    const blockMap = new Map((analysis.textBlocks || []).map(b => [b.id, b]));
    const regionMap = new Map((analysis.regionNodes || []).map(r => [r.id, r]));
    const lineToBlock = new Map();
    for(const block of analysis.textBlocks || []){ for(const lineId of block.lineIds || []) lineToBlock.set(lineId, block.id); }
    const seedBox = fieldSignature?.seed?.bbox || null;
    return (analysis.textLines || []).map((line, index) => {
      const blockId = lineToBlock.get(line.id) || null;
      const block = blockId ? blockMap.get(blockId) : null;
      let nearestRegion = null, nearestDist = Infinity;
      const lineBox = line?.geometry?.bbox || {};
      const lc = { x: (lineBox.x || 0) + ((lineBox.w || 0) / 2), y: (lineBox.y || 0) + ((lineBox.h || 0) / 2) };
      for(const region of analysis.regionNodes || []){
        const rb = region?.geometry?.bbox || {};
        const rc = { x: (rb.x || 0) + ((rb.w || 0) / 2), y: (rb.y || 0) + ((rb.h || 0) / 2) };
        const dist = Math.hypot(lc.x - rc.x, lc.y - rc.y);
        if(dist < nearestDist){ nearestDist = dist; nearestRegion = region; }
      }
      const seedCenter = seedBox ? { x: (Number(seedBox.x) || 0) + ((Number(seedBox.w) || 0) / 2), y: (Number(seedBox.y) || 0) + ((Number(seedBox.h) || 0) / 2) } : null;
      return createMatchCandidate({ candidateId: `line-candidate-${index + 1}`, nodeIds: [line.id, block?.id, nearestRegion?.id].filter(Boolean), localStructureRefs: { lineId: line.id, blockId: block?.id || null, regionId: nearestRegion?.id || null, siblingLineCount: block?.lineIds?.length || 0, graphEdgeCount: Number((analysis.textGraph?.edges || []).length || 0) }, regionRef: nearestRegion || null, blockRef: block || null, lineRef: line, tokenRefs: line.tokenIds || [], localCoordinateComparison: { seedCenter, candidateCenter: lc, page: Number(fieldSignature?.fieldIdentity?.page || canonicalPrecomputed?.page || 1) }, extractedValueCandidates: _fm_valueCandidatesFromCandidate({ lineRef: line }), debug: { nearestRegionId: nearestRegion?.id || null, nearestRegionDistance: nearestDist } });
    });
  }

  function matchFieldSignature({ fieldKey, fieldSignature, canonicalPrecomputed } = {}){
    const analysis = canonicalPrecomputed?.uploadedImageAnalysis;
    if(!analysis || !fieldSignature){
      return createFieldMatchResult({ fieldKey, value: '', confidence: 0, fallback: { reason: 'missing-signature-or-precomputed-artifact' }, rationale: createScoreBreakdown({ total: 0, notes: ['signature-matching-skipped'] }), debug: { candidateGeneration: [], ranking: null } });
    }
    const generatedCandidates = buildCandidates({ fieldSignature, canonicalPrecomputed });
    const rankedResult = rankCandidates({ fieldSignature, candidates: generatedCandidates, analysis });
    const ranked = rankedResult.ranked || [];
    const selected = ranked[0] || null, next = ranked[1] || null;
    const selectedValues = selected?.extractedValueCandidates || [];
    const value = selectedValues[0]?.text || '';
    const confidence = selected?.scoreBreakdown?.confidence || 0;
    const ambiguityGap = selected && next ? (selected.scoreBreakdown.weightedScore - next.scoreBreakdown.weightedScore) : null;
    return createFieldMatchResult({
      fieldKey,
      selectedCandidate: selected,
      candidates: ranked,
      extractedValueCandidates: selectedValues,
      value,
      confidence,
      ambiguity: { hasAmbiguity: ambiguityGap != null ? ambiguityGap < 0.08 : false, topScoreGap: ambiguityGap },
      rationale: createScoreBreakdown({ total: confidence, components: [{ key: 'candidateCount', value: ranked.length }, { key: 'bestWeightedScore', value: selected?.scoreBreakdown?.weightedScore || 0 }, { key: 'secondBestWeightedScore', value: next?.scoreBreakdown?.weightedScore || 0 }], notes: ['field-signature-matching-completed'] }),
      fallback: selected ? null : { reason: 'no-candidates' },
      debug: { candidateGeneration: generatedCandidates.map(c => ({ candidateId: c.candidateId, lineId: c.localStructureRefs?.lineId, blockId: c.localStructureRefs?.blockId, regionId: c.localStructureRefs?.regionId })), ranking: rankedResult.debug }
    });
  }

  // ── field-signature/index.js ───────────────────────────────────────────────
  function buildFieldSignature({ fieldMeta, selectionSeed, resolvedLocalSubgraph, localStructure, localCoordinateFrame } = {}){
    const serializeBBox = (bbox) => bbox ? { x: Number(bbox.x) || 0, y: Number(bbox.y) || 0, w: Number(bbox.w) || 0, h: Number(bbox.h) || 0 } : null;
    const anchorTokens = (localStructure?.anchorTokenCandidates || []).slice(0, 6).map(token => ({ nodeId: token.nodeId, text: token.text, normalizedText: token.normalizedText, parentLineId: token.parentLineId, parentBlockId: token.parentBlockId, geometry: token.geometry, score: Number(token?.score) || 0, confidence: Number(token?.confidence) || 0 }));
    const nearbyLabels = (localStructure?.labelCandidates || []).slice(0, 4).map(label => ({ nodeId: label.nodeId, text: label.lineText, normalizedText: label.normalizedText, geometry: label.geometry, labelCue: !!label.labelCue, score: Number(label?.score) || 0 }));
    const components = [
      ...anchorTokens.map(token => createFieldSignatureComponent({ componentType: 'anchor_token', nodeId: token.nodeId, nodeType: 'text_token', role: 'anchor', text: token.text, normalizedText: token.normalizedText, geometry: token.geometry, relationship: { parentLineId: token.parentLineId, parentBlockId: token.parentBlockId }, confidence: token.confidence, rationale: createScoreBreakdown({ total: token.score, components: [{ key: 'proximity', value: token.score }] }) })),
      ...nearbyLabels.map(label => createFieldSignatureComponent({ componentType: 'nearby_label', nodeId: label.nodeId, nodeType: 'text_line', role: 'label_candidate', text: label.text, normalizedText: label.normalizedText, geometry: label.geometry, relationship: { labelCue: label.labelCue }, confidence: label.score, rationale: createScoreBreakdown({ total: label.score, components: [{ key: 'label_score', value: label.score }] }) }))
    ];
    const graphRelationships = Array.isArray(resolvedLocalSubgraph?.retainedTypedEdges) ? resolvedLocalSubgraph.retainedTypedEdges.slice(0, 80) : [];
    const confidence = Math.max(0.15, Math.min(0.99, ((localStructure?.structuralConfidence || 0) * 0.45) + ((localCoordinateFrame?.confidence || 0) * 0.25) + (anchorTokens.length ? 0.15 : 0) + (nearbyLabels.length ? 0.1 : 0) + (graphRelationships.length ? 0.05 : 0)));
    return createFieldSignature({
      schemaVersion: 1,
      fieldIdentity: { fieldKey: fieldMeta?.fieldKey || null, fieldType: fieldMeta?.fieldType || null, page: Number(selectionSeed?.page) || null },
      seed: { bbox: serializeBBox(selectionSeed?.bbox || null), normalized: selectionSeed?.normalized || null, imageRef: selectionSeed?.imageRef || null },
      anchorTokens,
      nearbyLabels,
      structuralRelationships: { containingLine: localStructure?.containingLine || null, containingBlock: localStructure?.containingBlock || null, neighborhoodRoles: localStructure?.neighborhoodRoles || {} },
      containingRegions: localStructure?.containingRegionChain || [],
      siblingStructures: localStructure?.siblingNodes || {},
      localGeometry: { rawSelectionBBox: serializeBBox(selectionSeed?.bbox || null), localStructure: { containingLineBBox: serializeBBox(localStructure?.containingLine?.geometry?.bbox || null), containingBlockBBox: serializeBBox(localStructure?.containingBlock?.geometry?.bbox || null) } },
      localCoordinateFrame,
      graphRelationships,
      components,
      confidence,
      rationale: createScoreBreakdown({ total: confidence, components: [{ key: 'structuralConfidence', value: Number(localStructure?.structuralConfidence) || 0 }, { key: 'frameConfidence', value: Number(localCoordinateFrame?.confidence) || 0 }, { key: 'anchorTokenCount', value: anchorTokens.length }, { key: 'labelCount', value: nearbyLabels.length }, { key: 'edgeCount', value: graphRelationships.length }], notes: ['field-signature-built-for-future-matching'] }),
      debug: { resolvedLocalNodeCounts: { tokens: resolvedLocalSubgraph?.retainedTextTokenNodes?.length || 0, lines: resolvedLocalSubgraph?.retainedTextLineNodes?.length || 0, blocks: resolvedLocalSubgraph?.retainedTextBlockNodes?.length || 0, regions: resolvedLocalSubgraph?.retainedRegionNodes?.length || 0 } }
    });
  }

  // ── expose global ──────────────────────────────────────────────────────────
  root.WrokitVisionFieldPipeline = {
    SelectionAssociation: { resolveSeed, associateSelection },
    LocalRelevance:       { scoreLocalRelevance },
    LocalSubgraph:        { resolveLocalSubgraph },
    LocalStructure:       { reconstructLocalStructure },
    LocalFrame:           { estimateLocalCoordinateFrame },
    FieldSignature:       { buildFieldSignature },
    FieldMatcher:         { matchFieldSignature, buildCandidates }
  };

})(typeof self !== 'undefined' ? self : this);
