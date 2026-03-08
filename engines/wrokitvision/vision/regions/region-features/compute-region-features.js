'use strict';

const { ensureBBox } = require('../../types');

function overlapRatio(a, b){
  const ax1 = a.x + a.w;
  const ay1 = a.y + a.h;
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  const ox = Math.max(0, Math.min(ax1, bx1) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(ay1, by1) - Math.max(a.y, b.y));
  const overlap = ox * oy;
  const area = Math.max(1, a.w * a.h);
  return overlap / area;
}

function computeRegionFeatures(regionNodes = [], textTokens = []){
  return regionNodes.map(region => {
    const box = ensureBBox(region.geometry?.bbox || {});
    const inside = textTokens.filter(token => overlapRatio(box, ensureBBox(token.geometry?.bbox || {})) >= 0.2);
    const edgeDensityProxy = Math.min(1, inside.length / Math.max(1, (box.w * box.h) / 4000));
    const textDensity = Math.min(1, inside.length / Math.max(1, (box.w * box.h) / 2500));

    return {
      ...region,
      textDensity,
      features: {
        ...region.features,
        area: box.w * box.h,
        tokenCount: inside.length,
        averageTokenConfidence: inside.reduce((s, tok) => s + (Number(tok.confidence) || 0), 0) / Math.max(1, inside.length),
        edgeDensityProxy,
        textureProxy: Math.max(0, 1 - Math.abs((box.w / Math.max(1, box.h)) - 1) * 0.2)
      }
    };
  });
}

module.exports = {
  computeRegionFeatures
};
