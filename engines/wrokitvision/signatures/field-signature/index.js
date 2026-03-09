'use strict';

const { createFieldSignature, createFieldSignatureComponent, createScoreBreakdown } = require('../../vision/types');

function serializeBBox(bbox){
  if(!bbox) return null;
  return {
    x: Number(bbox.x) || 0,
    y: Number(bbox.y) || 0,
    w: Number(bbox.w) || 0,
    h: Number(bbox.h) || 0
  };
}

function buildFieldSignature({ fieldMeta, selectionSeed, resolvedLocalSubgraph, localStructure, localCoordinateFrame } = {}){
  const anchorTokens = (localStructure?.anchorTokenCandidates || []).slice(0, 6).map((token) => ({
    nodeId: token.nodeId,
    text: token.text,
    normalizedText: token.normalizedText,
    parentLineId: token.parentLineId,
    parentBlockId: token.parentBlockId,
    geometry: token.geometry,
    score: Number(token?.score) || 0,
    confidence: Number(token?.confidence) || 0
  }));

  const nearbyLabels = (localStructure?.labelCandidates || []).slice(0, 4).map((label) => ({
    nodeId: label.nodeId,
    text: label.lineText,
    normalizedText: label.normalizedText,
    geometry: label.geometry,
    labelCue: !!label.labelCue,
    score: Number(label?.score) || 0
  }));

  const components = [
    ...anchorTokens.map((token) => createFieldSignatureComponent({
      componentType: 'anchor_token',
      nodeId: token.nodeId,
      nodeType: 'text_token',
      role: 'anchor',
      text: token.text,
      normalizedText: token.normalizedText,
      geometry: token.geometry,
      relationship: { parentLineId: token.parentLineId, parentBlockId: token.parentBlockId },
      confidence: token.confidence,
      rationale: createScoreBreakdown({ total: token.score, components: [{ key: 'proximity', value: token.score }] })
    })),
    ...nearbyLabels.map((label) => createFieldSignatureComponent({
      componentType: 'nearby_label',
      nodeId: label.nodeId,
      nodeType: 'text_line',
      role: 'label_candidate',
      text: label.text,
      normalizedText: label.normalizedText,
      geometry: label.geometry,
      relationship: { labelCue: label.labelCue },
      confidence: label.score,
      rationale: createScoreBreakdown({ total: label.score, components: [{ key: 'label_score', value: label.score }] })
    }))
  ];

  const graphRelationships = Array.isArray(resolvedLocalSubgraph?.retainedTypedEdges)
    ? resolvedLocalSubgraph.retainedTypedEdges.slice(0, 80)
    : [];

  const confidence = Math.max(0.15, Math.min(0.99,
    ((localStructure?.structuralConfidence || 0) * 0.45)
    + ((localCoordinateFrame?.confidence || 0) * 0.25)
    + (anchorTokens.length ? 0.15 : 0)
    + (nearbyLabels.length ? 0.1 : 0)
    + (graphRelationships.length ? 0.05 : 0)
  ));

  return createFieldSignature({
    schemaVersion: 1,
    fieldIdentity: {
      fieldKey: fieldMeta?.fieldKey || null,
      fieldType: fieldMeta?.fieldType || null,
      page: Number(selectionSeed?.page) || null
    },
    seed: {
      bbox: serializeBBox(selectionSeed?.bbox || null),
      normalized: selectionSeed?.normalized || null,
      imageRef: selectionSeed?.imageRef || null
    },
    anchorTokens,
    nearbyLabels,
    structuralRelationships: {
      containingLine: localStructure?.containingLine || null,
      containingBlock: localStructure?.containingBlock || null,
      neighborhoodRoles: localStructure?.neighborhoodRoles || {}
    },
    containingRegions: localStructure?.containingRegionChain || [],
    siblingStructures: localStructure?.siblingNodes || {},
    localGeometry: {
      rawSelectionBBox: serializeBBox(selectionSeed?.bbox || null),
      localStructure: {
        containingLineBBox: serializeBBox(localStructure?.containingLine?.geometry?.bbox || null),
        containingBlockBBox: serializeBBox(localStructure?.containingBlock?.geometry?.bbox || null)
      }
    },
    localCoordinateFrame,
    graphRelationships,
    components,
    confidence,
    rationale: createScoreBreakdown({
      total: confidence,
      components: [
        { key: 'structuralConfidence', value: Number(localStructure?.structuralConfidence) || 0 },
        { key: 'frameConfidence', value: Number(localCoordinateFrame?.confidence) || 0 },
        { key: 'anchorTokenCount', value: anchorTokens.length },
        { key: 'labelCount', value: nearbyLabels.length },
        { key: 'edgeCount', value: graphRelationships.length }
      ],
      notes: ['field-signature-built-for-future-matching']
    }),
    debug: {
      resolvedLocalNodeCounts: {
        tokens: resolvedLocalSubgraph?.retainedTextTokenNodes?.length || 0,
        lines: resolvedLocalSubgraph?.retainedTextLineNodes?.length || 0,
        blocks: resolvedLocalSubgraph?.retainedTextBlockNodes?.length || 0,
        regions: resolvedLocalSubgraph?.retainedRegionNodes?.length || 0
      }
    }
  });
}

module.exports = {
  buildFieldSignature
};
