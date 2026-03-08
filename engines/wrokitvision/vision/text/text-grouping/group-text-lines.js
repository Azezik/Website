'use strict';

const { createTextLineNode, ensureBBox } = require('../../types');

function unionBbox(items){
  if(!items.length) return ensureBBox({});
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for(const item of items){
    const b = ensureBBox(item.geometry?.bbox || item);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function groupTextLines(textTokens = [], { idFactory } = {}){
  const sorted = textTokens.slice().sort((a, b) => {
    const ay = a.geometry?.bbox?.y || 0;
    const by = b.geometry?.bbox?.y || 0;
    if(Math.abs(ay - by) > 6) return ay - by;
    return (a.geometry?.bbox?.x || 0) - (b.geometry?.bbox?.x || 0);
  });

  const lines = [];
  for(const token of sorted){
    const box = token.geometry?.bbox || {};
    const cy = box.y + (box.h / 2);
    const line = lines.find(candidate => Math.abs(cy - candidate.cy) <= Math.max(6, box.h * 0.7));
    if(line){
      line.tokens.push(token);
      line.cy = (line.cy + cy) / 2;
    } else {
      lines.push({ cy, tokens: [token] });
    }
  }

  return lines.map(({ tokens }) => {
    const tokenIds = tokens.map(tok => tok.id);
    const text = tokens.slice().sort((a, b) => (a.geometry?.bbox?.x || 0) - (b.geometry?.bbox?.x || 0)).map(tok => tok.text).join(' ').replace(/\s+/g, ' ').trim();
    const lineNode = createTextLineNode({
      id: idFactory('txt_line'),
      geometry: { bbox: unionBbox(tokens) },
      confidence: tokens.reduce((sum, tok) => sum + (Number(tok.confidence) || 0), 0) / Math.max(1, tokens.length),
      provenance: { stage: 'text-grouping', detector: 'line-band-grouping' },
      tokenIds,
      text,
      normalizedText: text.toLowerCase(),
      features: { tokenCount: tokenIds.length }
    });
    for(const tok of tokens){
      tok.parentLineId = lineNode.id;
    }
    return lineNode;
  });
}

module.exports = {
  groupTextLines,
  unionBbox
};
