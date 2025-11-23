const assert = require('assert');
const { extractConfigStatic } = require('../tools/static-field-mode.js');
const selectionFirst = require('../orchestrator.js');

const tokens = [
  { text: '176', x: 10, y: 10, w: 24, h: 8, page: 1 },
  { text: 'RAYMOND', x: 38, y: 10, w: 60, h: 8, page: 1 },
  { text: 'L', x: 102, y: 10, w: 5, h: 8, page: 1 },
  { text: 'ARNPRIOR', x: 10, y: 24, w: 70, h: 8, page: 1 },
  { text: 'ONTARIO', x: 84, y: 24, w: 60, h: 8, page: 1 },
  { text: 'K7S', x: 10, y: 38, w: 20, h: 8, page: 1 },
  { text: '3G8', x: 34, y: 38, w: 20, h: 8, page: 1 }
];

const bbox = { x: 5, y: 5, w: 160, h: 45, page: 1 };

const configResult = extractConfigStatic({ tokens, box: bbox, snappedText: '' });
assert.strictEqual(configResult.text, '176 RAYMOND L\nARNPRIOR ONTARIO\nK7S 3G8');
assert.strictEqual(configResult.hits.length, tokens.length);

function strictClean(hits){
  const raw = hits.map(t => t.text).join(' ');
  return { value: raw.replace('176 RAYMOND L ', '').split(' K7S')[0], raw };
}

const runResult = selectionFirst(tokens, strictClean);
assert.strictEqual(runResult.raw, '176 RAYMOND L ARNPRIOR ONTARIO K7S 3G8');
assert.strictEqual(runResult.value, 'ARNPRIOR ONTARIO');
assert.strictEqual(runResult.cleanedOk, true);

console.log('Static mode tests passed.');
