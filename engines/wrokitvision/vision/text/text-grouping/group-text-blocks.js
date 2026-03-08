'use strict';

const { createTextBlockNode } = require('../../types');
const { unionBbox } = require('./group-text-lines');

function groupTextBlocks(textLines = [], textTokens = [], { idFactory } = {}){
  const sorted = textLines.slice().sort((a, b) => (a.geometry?.bbox?.y || 0) - (b.geometry?.bbox?.y || 0));
  const blocks = [];
  for(const line of sorted){
    const box = line.geometry?.bbox || {};
    const candidate = blocks.find(block => {
      const b = block.bbox;
      const verticalGap = Math.max(0, box.y - (b.y + b.h));
      const overlapX = Math.max(0, Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x));
      return verticalGap <= Math.max(14, box.h * 1.25) && overlapX >= Math.min(box.w, b.w) * 0.25;
    });

    if(candidate){
      candidate.lines.push(line);
      candidate.bbox = unionBbox(candidate.lines.map(l => l.geometry.bbox));
    } else {
      blocks.push({ lines: [line], bbox: line.geometry?.bbox || {} });
    }
  }

  return blocks.map(({ lines }) => {
    const lineIds = lines.map(line => line.id);
    const tokenIds = lines.flatMap(line => line.tokenIds || []);
    const text = lines.map(line => line.text).join('\n').trim();
    const block = createTextBlockNode({
      id: idFactory('txt_block'),
      geometry: { bbox: unionBbox(lines.map(line => line.geometry?.bbox || {})) },
      confidence: lines.reduce((sum, line) => sum + (Number(line.confidence) || 0), 0) / Math.max(1, lines.length),
      provenance: { stage: 'text-grouping', detector: 'block-stacking' },
      lineIds,
      tokenIds,
      text,
      normalizedText: text.toLowerCase(),
      features: { lineCount: lineIds.length, tokenCount: tokenIds.length }
    });

    for(const line of lines){
      line.parentBlockId = block.id;
    }
    for(const token of textTokens){
      if(token.parentLineId && lineIds.includes(token.parentLineId)){
        token.parentBlockId = block.id;
      }
    }
    return block;
  });
}

module.exports = {
  groupTextBlocks
};
