const assert = require('assert');
const { assembleStaticFieldPipeline } = require('../tools/static-field-mode.js');

// Multiline customer address style block
const multiTokens = [
  { text: 'ACME', x: 10, y: 10, w: 40, h: 8, page: 1 },
  { text: 'INC', x: 54, y: 10, w: 20, h: 8, page: 1 },
  { text: '123', x: 10, y: 22, w: 20, h: 8, page: 1 },
  { text: 'MAPLE', x: 34, y: 22, w: 35, h: 8, page: 1 },
  { text: 'RD', x: 72, y: 22, w: 16, h: 8, page: 1 },
  { text: 'TORONTO', x: 10, y: 34, w: 60, h: 8, page: 1 },
  { text: 'ON', x: 74, y: 34, w: 16, h: 8, page: 1 },
  { text: 'M4B', x: 10, y: 46, w: 20, h: 8, page: 1 },
  { text: '1B3', x: 34, y: 46, w: 20, h: 8, page: 1 },
];
const multiBox = { x: 5, y: 5, w: 120, h: 50, page: 1 };

const configAddress = assembleStaticFieldPipeline({
  tokens: multiTokens,
  selectionBox: multiBox,
  searchBox: multiBox,
  snappedText: '',
  multiline: true,
  minOverlap: 0.5,
});

const runAddress = assembleStaticFieldPipeline({
  tokens: multiTokens,
  selectionBox: multiBox,
  searchBox: multiBox,
  snappedText: '',
  multiline: true,
  minOverlap: 0.5,
});

assert.strictEqual(configAddress.text, 'ACME INC\n123 MAPLE RD\nTORONTO ON\nM4B 1B3');
assert.strictEqual(runAddress.text, configAddress.text);
assert.strictEqual(configAddress.lineCount, runAddress.lineCount);
assert.deepStrictEqual(configAddress.lineMetrics, runAddress.lineMetrics);

// Single-line salesperson style field
const singleTokens = [
  { text: 'Jamie', x: 5, y: 5, w: 30, h: 8, page: 1 },
  { text: 'Lee', x: 38, y: 5, w: 22, h: 8, page: 1 },
];
const singleBox = { x: 0, y: 0, w: 90, h: 15, page: 1 };
const configSales = assembleStaticFieldPipeline({ tokens: singleTokens, selectionBox: singleBox, searchBox: singleBox, minOverlap: 0.5 });
const runSales = assembleStaticFieldPipeline({ tokens: singleTokens, selectionBox: singleBox, searchBox: singleBox, minOverlap: 0.5 });

assert.strictEqual(configSales.text, 'Jamie Lee');
assert.strictEqual(runSales.text, configSales.text);
assert.strictEqual(configSales.lineCount, 1);
assert.deepStrictEqual(configSales.lineMetrics, runSales.lineMetrics);

console.log('Static pipeline consistency tests passed.');
