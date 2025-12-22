const assert = require('assert');
const {
  captureConstellation,
  matchConstellation,
  DEFAULT_TOLERANCE
} = require('../tools/keyword-constellation.js');

function makeToken(x, y, text, page=1){
  return { x, y, w: 10, h: 10, text, page };
}

(function testConstellationReconstruction(){
  const pageW = 200;
  const pageH = 200;
  const fieldBoxPx = { x: 100, y: 100, w: 20, h: 10, page: 1 };
  const normBox = { x0n: fieldBoxPx.x / pageW, y0n: fieldBoxPx.y / pageH, wN: fieldBoxPx.w / pageW, hN: fieldBoxPx.h / pageH };
  const tokens = [
    makeToken(80, 100, 'Total'),
    makeToken(60, 120, 'Subtotal'),
    makeToken(100, 80, 'HST'),
    makeToken(20, 150, 'Balance'),
    makeToken(5, 175, 'Account')
  ];

  const constellation = captureConstellation('invoice_total', fieldBoxPx, normBox, 1, pageW, pageH, tokens, {});
  assert.ok(constellation, 'constellation should be captured');
  assert.strictEqual(constellation.anchor.normText, 'total');
  assert.strictEqual(constellation.supports.length, 4);
  assert.strictEqual(constellation.crossLinks.length, 3);

  const shiftedTokens = tokens.map(t => ({ ...t, x: t.x + 20, y: t.y + 20 }));
  const match = matchConstellation(constellation, shiftedTokens, { page: 1, pageW, pageH, tolerance: DEFAULT_TOLERANCE });
  assert.ok(match && match.best, 'should find a matching constellation instance');
  assert.strictEqual(match.best.matchedEdges, match.best.totalEdges, 'all edges should match');

  const predicted = match.best.predictedBoxPx;
  assert.ok(Math.abs(predicted.x - 120) < 1, 'predicted x should shift with tokens');
  assert.ok(Math.abs(predicted.y - 120) < 1, 'predicted y should shift with tokens');
  assert.ok(Math.abs(predicted.w - fieldBoxPx.w) < 0.001, 'width should be preserved');
  assert.ok(Math.abs(predicted.h - fieldBoxPx.h) < 0.001, 'height should be preserved');
})();

console.log('Keyword constellation tests passed.');
