'use strict';

const { createLocalStructure, createScoreBreakdown } = require('../../vision/types');

function center(box){ return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) }; }
function distance(a, b){ return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0)); }

function inferContainingRegions({ seedBox, regions = [] } = {}){
  const chain = regions
    .filter((region) => {
      const box = region?.geometry?.bbox || {};
      return box.x <= seedBox.x && box.y <= seedBox.y && (box.x + box.w) >= (seedBox.x + seedBox.w) && (box.y + box.h) >= (seedBox.y + seedBox.h);
    })
    .sort((a, b) => ((a?.geometry?.bbox?.w || 0) * (a?.geometry?.bbox?.h || 0)) - ((b?.geometry?.bbox?.w || 0) * (b?.geometry?.bbox?.h || 0)))
    .map((region) => ({
      nodeId: region.id,
      nodeType: region.nodeType,
      geometry: region.geometry,
      orientation: Number(region?.geometry?.orientation) || 0,
      confidence: Number(region?.confidence) || 0
    }));
  return chain;
}

function buildRoleHints({ tokens = [], lines = [], blocks = [], regions = [] } = {}){
  const tokenIds = new Set(tokens.map(t => t.id));
  const lineIds = new Set(lines.map(l => l.id));
  return {
    tokenRoleById: tokens.reduce((acc, token) => {
      acc[token.id] = tokenIds.size === 1 ? 'seed-anchor' : 'local-anchor-candidate';
      return acc;
    }, {}),
    lineRoleById: lines.reduce((acc, line) => {
      acc[line.id] = lineIds.size === 1 ? 'seed-line' : 'sibling-line';
      return acc;
    }, {}),
    blockRoleById: blocks.reduce((acc, block, index) => {
      acc[block.id] = index === 0 ? 'containing-block-candidate' : 'sibling-block-candidate';
      return acc;
    }, {}),
    regionRoleById: regions.reduce((acc, region, index) => {
      acc[region.id] = index === 0 ? 'closest-region-candidate' : 'nearby-region-candidate';
      return acc;
    }, {})
  };
}

function reconstructLocalStructure({ resolvedLocalSubgraph } = {}){
  const seed = resolvedLocalSubgraph?.selectionSeed || null;
  const seedBox = seed?.bbox || { x: 0, y: 0, w: 0, h: 0 };
  const seedCenter = center(seedBox);

  const tokens = Array.isArray(resolvedLocalSubgraph?.retainedTextTokenNodes) ? resolvedLocalSubgraph.retainedTextTokenNodes : [];
  const lines = Array.isArray(resolvedLocalSubgraph?.retainedTextLineNodes) ? resolvedLocalSubgraph.retainedTextLineNodes : [];
  const blocks = Array.isArray(resolvedLocalSubgraph?.retainedTextBlockNodes) ? resolvedLocalSubgraph.retainedTextBlockNodes : [];
  const regions = Array.isArray(resolvedLocalSubgraph?.retainedRegionNodes) ? resolvedLocalSubgraph.retainedRegionNodes : [];

  const anchorTokenCandidates = tokens
    .map((token) => {
      const tokenCenter = center(token?.geometry?.bbox || {});
      const d = distance(seedCenter, tokenCenter);
      const normalized = 1 / (1 + d);
      return {
        nodeId: token.id,
        text: token.text || '',
        normalizedText: token.normalizedText || '',
        parentLineId: token.parentLineId || null,
        parentBlockId: token.parentBlockId || null,
        geometry: token.geometry || null,
        confidence: Number(token?.confidence) || 0,
        score: normalized
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const lineById = new Map(lines.map((line) => [line.id, line]));
  const labelCandidates = lines
    .map((line) => {
      const lc = String(line?.normalizedText || line?.text || '').toLowerCase();
      const hasLabelCue = /invoice|date|total|amount|tax|vendor|seller|company|bill to|sold to|customer|subtotal|discount/.test(lc) ? 1 : 0;
      const lineCenter = center(line?.geometry?.bbox || {});
      const d = distance(seedCenter, lineCenter);
      return {
        nodeId: line.id,
        lineText: line.text || '',
        normalizedText: line.normalizedText || '',
        geometry: line.geometry || null,
        score: (hasLabelCue * 0.65) + ((1 / (1 + d)) * 0.35),
        labelCue: !!hasLabelCue
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const containingLine = anchorTokenCandidates[0]?.parentLineId ? lineById.get(anchorTokenCandidates[0].parentLineId) || null : null;
  const containingBlock = containingLine?.parentBlockId
    ? (blocks.find((block) => block.id === containingLine.parentBlockId) || null)
    : (anchorTokenCandidates[0]?.parentBlockId ? (blocks.find((block) => block.id === anchorTokenCandidates[0].parentBlockId) || null) : null);

  const containingRegionChain = inferContainingRegions({ seedBox, regions });

  const siblingLines = lines.filter(line => containingLine && line.id !== containingLine.id).slice(0, 10);
  const siblingBlocks = blocks.filter(block => containingBlock && block.id !== containingBlock.id).slice(0, 6);
  const siblingRegions = regions
    .filter((region) => !containingRegionChain.some(chainNode => chainNode.nodeId === region.id))
    .slice(0, 10);

  const rowTendencyScore = (() => {
    if(!containingLine) return 0;
    const refY = (containingLine.geometry?.bbox?.y || 0) + ((containingLine.geometry?.bbox?.h || 0) / 2);
    const closeY = siblingLines.filter((line) => {
      const y = (line.geometry?.bbox?.y || 0) + ((line.geometry?.bbox?.h || 0) / 2);
      return Math.abs(y - refY) <= Math.max(8, (containingLine.geometry?.bbox?.h || 0));
    }).length;
    return Math.min(1, closeY / Math.max(1, siblingLines.length || 1));
  })();

  const columnTendencyScore = (() => {
    if(!containingLine) return 0;
    const refX = (containingLine.geometry?.bbox?.x || 0) + ((containingLine.geometry?.bbox?.w || 0) / 2);
    const closeX = siblingLines.filter((line) => {
      const x = (line.geometry?.bbox?.x || 0) + ((line.geometry?.bbox?.w || 0) / 2);
      return Math.abs(x - refX) <= Math.max(20, (containingLine.geometry?.bbox?.w || 0) * 0.25);
    }).length;
    return Math.min(1, closeX / Math.max(1, siblingLines.length || 1));
  })();

  const structuralConfidence = Math.max(0.2, Math.min(0.98,
    (anchorTokenCandidates.length ? 0.3 : 0)
    + (containingLine ? 0.22 : 0)
    + (containingBlock ? 0.16 : 0)
    + (containingRegionChain.length ? 0.18 : 0)
    + (labelCandidates.length ? 0.14 : 0)
  ));

  return createLocalStructure({
    seed,
    anchorTokenCandidates,
    labelCandidates,
    containingLine: containingLine
      ? { nodeId: containingLine.id, text: containingLine.text || '', geometry: containingLine.geometry || null, orientation: Number(containingLine?.geometry?.orientation) || 0 }
      : null,
    containingBlock: containingBlock
      ? { nodeId: containingBlock.id, text: containingBlock.text || '', geometry: containingBlock.geometry || null, orientation: Number(containingBlock?.geometry?.orientation) || 0 }
      : null,
    containingRegionChain,
    siblingNodes: {
      tokens: anchorTokenCandidates.slice(1),
      lines: siblingLines.map(line => ({ nodeId: line.id, text: line.text || '', geometry: line.geometry || null })),
      blocks: siblingBlocks.map(block => ({ nodeId: block.id, text: block.text || '', geometry: block.geometry || null })),
      regions: siblingRegions.map(region => ({ nodeId: region.id, geometry: region.geometry || null, confidence: Number(region?.confidence) || 0 }))
    },
    neighborhoodRoles: {
      ...buildRoleHints({ tokens, lines, blocks, regions }),
      rowTendencyScore,
      columnTendencyScore
    },
    structuralConfidence,
    rationale: createScoreBreakdown({
      total: structuralConfidence,
      components: [
        { key: 'anchorTokenCandidates', value: anchorTokenCandidates.length },
        { key: 'labelCandidates', value: labelCandidates.length },
        { key: 'containingLinePresent', value: containingLine ? 1 : 0 },
        { key: 'containingBlockPresent', value: containingBlock ? 1 : 0 },
        { key: 'containingRegionDepth', value: containingRegionChain.length },
        { key: 'rowTendencyScore', value: rowTendencyScore },
        { key: 'columnTendencyScore', value: columnTendencyScore }
      ],
      notes: ['local-structure-built-from-resolved-subgraph']
    }),
    debug: {
      retainedNodeCounts: {
        tokens: tokens.length,
        lines: lines.length,
        blocks: blocks.length,
        regions: regions.length
      }
    }
  });
}

module.exports = {
  reconstructLocalStructure
};
