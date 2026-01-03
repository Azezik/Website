const assert = require('assert');
const { isExplicitSubordinate, scopeTokensForField } = require('../tools/area-scoping.js');

(function globalFieldsIgnoreAreaScope(){
  const areaBox = { x: 0, y: 0, w: 100, h: 100, page: 1 };
  const tokens = [
    { text: 'inside', x: 10, y: 10, w: 10, h: 10, page: 1 },
    { text: 'outside', x: 150, y: 10, w: 10, h: 10, page: 1 }
  ];
  const field = { fieldKey: 'invoice_total', isSubordinate: false };
  const scoped = scopeTokensForField(field, tokens, areaBox);
  assert.deepStrictEqual(scoped.map(t => t.text), ['inside', 'outside'], 'global fields should not be clipped by area bounds');
})();

(function subordinateFieldsStayScoped(){
  const areaBox = { x: 0, y: 0, w: 100, h: 100, page: 1 };
  const tokens = [
    { text: 'inside', x: 10, y: 10, w: 10, h: 10, page: 1 },
    { text: 'outside', x: 150, y: 10, w: 10, h: 10, page: 1 }
  ];
  const field = { fieldKey: 'line_total', isSubordinate: true, areaId: 'Container' };
  const scoped = scopeTokensForField(field, tokens, areaBox);
  assert.deepStrictEqual(scoped.map(t => t.text), ['inside'], 'subordinate fields should stay within their container bounds');
  assert.strictEqual(isExplicitSubordinate(field), true, 'explicit subordinate flag should be honored');
})();

(function areaHintsDoNotPromoteGlobals(){
  const globalField = { fieldKey: 'notes', areaId: 'Container', isSubordinate: false };
  assert.strictEqual(isExplicitSubordinate(globalField), false, 'area ownership must be explicit');
  const relativeBoxField = { fieldKey: 'line_item', areaRelativeBox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  assert.strictEqual(isExplicitSubordinate(relativeBoxField), true, 'relative geometry still implies subordination');
})();

console.log('Area scoping checks passed.');
