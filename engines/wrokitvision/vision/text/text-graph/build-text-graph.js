'use strict';

const { createGraphEdge, createScoreBreakdown, ensureBBox } = require('../../types');

function center(box){
  return { x: box.x + (box.w / 2), y: box.y + (box.h / 2) };
}

function buildTextGraph({ textTokens = [], textLines = [], textBlocks = [], idFactory } = {}){
  const edges = [];

  for(const token of textTokens){
    if(token.parentLineId){
      edges.push(createGraphEdge({
        edgeId: idFactory('edge_text'),
        sourceNodeId: token.id,
        targetNodeId: token.parentLineId,
        edgeType: 'token_to_line',
        weight: 1,
        rationale: createScoreBreakdown({ total: 1 }),
        provenance: { stage: 'text-graph' }
      }));
    }
  }

  for(const line of textLines){
    if(line.parentBlockId){
      edges.push(createGraphEdge({
        edgeId: idFactory('edge_text'),
        sourceNodeId: line.id,
        targetNodeId: line.parentBlockId,
        edgeType: 'line_to_block',
        weight: 1,
        rationale: createScoreBreakdown({ total: 1 }),
        provenance: { stage: 'text-graph' }
      }));
    }
  }

  for(let i = 0; i < textLines.length; i++){
    for(let j = i + 1; j < textLines.length; j++){
      const a = textLines[i];
      const b = textLines[j];
      const ca = center(ensureBBox(a.geometry?.bbox || {}));
      const cb = center(ensureBBox(b.geometry?.bbox || {}));
      const dy = Math.abs(ca.y - cb.y);
      const dx = Math.abs(ca.x - cb.x);
      if(dy < 20 && dx < 400){
        const w = Math.max(0, 1 - (dx / 400));
        edges.push(createGraphEdge({
          edgeId: idFactory('edge_text'),
          sourceNodeId: a.id,
          targetNodeId: b.id,
          edgeType: 'line_horizontal_neighbor',
          weight: w,
          rationale: createScoreBreakdown({ total: w, components: [{ key: 'dx', value: dx }] }),
          provenance: { stage: 'text-graph' }
        }));
      }
    }
  }

  return {
    nodes: [...textTokens, ...textLines, ...textBlocks],
    edges
  };
}

module.exports = {
  buildTextGraph
};
