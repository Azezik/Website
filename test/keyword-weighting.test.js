const assert = require('assert');
const {
  chooseKeywordMatch,
  computeKeywordWeight,
  triangulateBox,
  MAX_KEYWORD_RADIUS
} = require('../tools/keyword-weighting.js');

(function testNoRelations(){
  const weight = computeKeywordWeight({ x: 0, y: 0, w: 10, h: 10 }, null, { pageW: 100, pageH: 100 });
  assert.strictEqual(weight, 1, 'missing prediction should be neutral');
})();

(function testMotherBoost(){
  const relation = { text: 'total', category: 'invoice_total', offset: { dx: 0.1, dy: 0, dw: 0, dh: 0 } };
  const keywordIndex = [
    { keyword: 'total', category: 'invoice_total', bboxPx: { x: 100, y: 100, w: 40, h: 20, page: 1 } }
  ];
  const reference = { x: 200, y: 100, w: 40, h: 20 };
  const match = chooseKeywordMatch(relation, keywordIndex, reference, 1000, 1000);
  assert.ok(match && match.predictedBox, 'should find matching keyword');
  const weight = computeKeywordWeight(reference, match.predictedBox, { pageW: 1000, pageH: 1000 });
  assert.ok(weight > 1 && weight <= 1.2, 'close keyword should boost confidence');
})();

(function testMotherFar(){
  const relation = { text: 'total', category: 'invoice_total', offset: { dx: 0.1, dy: 0, dw: 0, dh: 0 } };
  const keywordIndex = [
    { keyword: 'total', category: 'invoice_total', bboxPx: { x: 100, y: 100, w: 40, h: 20, page: 1 } }
  ];
  const reference = { x: (1 + MAX_KEYWORD_RADIUS) * 1000, y: 100, w: 40, h: 20 };
  const match = chooseKeywordMatch(relation, keywordIndex, reference, 1000, 1000);
  assert.strictEqual(match, null, 'far keyword should be ignored');
  const weight = computeKeywordWeight(reference, match?.predictedBox, { pageW: 1000, pageH: 1000 });
  assert.strictEqual(weight, 1, 'ignored keyword should not alter confidence');
})();

(function testTriangulation(){
  const relations = {
    mother: { text: 'total', category: 'invoice_total', offset: { dx: 0.1, dy: 0, dw: 0, dh: 0 } },
    secondaries: [
      { text: 'amount due', category: 'invoice_total', offset: { dx: 0.12, dy: 0, dw: 0, dh: 0 } }
    ]
  };
  const keywordIndex = [
    { keyword: 'total', category: 'invoice_total', bboxPx: { x: 100, y: 100, w: 40, h: 20, page: 1 } },
    { keyword: 'amount due', category: 'invoice_total', bboxPx: { x: 150, y: 105, w: 40, h: 20, page: 1 } }
  ];
  const predicted = triangulateBox(relations, keywordIndex, 1000, 1000, { x: 200, y: 100, w: 40, h: 20 });
  assert.ok(predicted && predicted.box, 'triangulation should produce a predicted box');
  const centerX = predicted.box.x + predicted.box.w / 2;
  const expectedCenters = [220, 290];
  assert.ok(centerX >= Math.min(...expectedCenters) && centerX <= Math.max(...expectedCenters), 'triangulated center should sit between predicted anchors');
})();

(function testStrongAnchorCap(){
  const relation = { text: 'total', category: 'invoice_total', offset: { dx: 0.1, dy: 0, dw: 0, dh: 0 } };
  const keywordIndex = [
    { keyword: 'total', category: 'invoice_total', bboxPx: { x: 100, y: 100, w: 40, h: 20, page: 1 } }
  ];
  const reference = { x: 200, y: 100, w: 40, h: 20 };
  const match = chooseKeywordMatch(relation, keywordIndex, reference, 1000, 1000);
  const weight = computeKeywordWeight(reference, match.predictedBox, { pageW: 1000, pageH: 1000, strongAnchor: true });
  assert.ok(weight <= 1.05, 'strong anchor should cap the boost');
})();

console.log('Keyword weighting tests passed.');
