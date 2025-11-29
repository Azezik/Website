const assert = require('assert');
const { extractConfigStatic, finalizeConfigValue, assembleTextFromBox } = require('../tools/static-field-mode.js');
const StaticFieldPipeline = require('../tools/static-field-pipeline.js');
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

const snappedBox = { x: 40, y: 20, w: 90, h: 10, page: 1 }; // would catch only part of line 2
const configUIResult = finalizeConfigValue({
  tokens,
  selectionBox: bbox,
  snappedBox,
  snappedText: 'ARNPRIOR ONTARIO',
  cleanFn: (_, raw) => ({ value: raw }),
  multiline: true
});

assert.strictEqual(configUIResult.value, '176 RAYMOND L\nARNPRIOR ONTARIO\nK7S 3G8');
assert.strictEqual(configUIResult.raw, '176 RAYMOND L\nARNPRIOR ONTARIO\nK7S 3G8');
assert.strictEqual(configUIResult.hits.length, tokens.length);
assert.deepStrictEqual(configUIResult.box, bbox);

// Run-mode assembly should keep every line inside the bbox when multiline is requested
const runAssembly = assembleTextFromBox({ tokens, box: bbox, multiline: true, minOverlap: 0.7 });
assert.strictEqual(runAssembly.text, '176 RAYMOND L\nARNPRIOR ONTARIO\nK7S 3G8');
assert.strictEqual(runAssembly.hits.length, tokens.length);

// Even without the explicit multiline flag, multiple lines inside the box should be joined
const autoMultiline = assembleTextFromBox({ tokens, box: bbox, multiline: false });
assert.strictEqual(autoMultiline.text, '176 RAYMOND L\nARNPRIOR ONTARIO\nK7S 3G8');
assert.strictEqual(autoMultiline.hits.length, tokens.length);

const runResult = selectionFirst(tokens, strictClean);
assert.strictEqual(runResult.raw, '176 RAYMOND L ARNPRIOR ONTARIO K7S 3G8');
assert.strictEqual(runResult.value, 'ARNPRIOR ONTARIO');
assert.strictEqual(runResult.cleanedOk, true);

const nameTokens = [
  { text: 'Alice', x: 10, y: 10, w: 30, h: 8, page: 1 },
  { text: 'Smith', x: 44, y: 10, w: 32, h: 8, page: 1 },
  { text: '123', x: 10, y: 22, w: 18, h: 8, page: 1 },
  { text: 'Maple', x: 30, y: 22, w: 36, h: 8, page: 1 },
  { text: 'St', x: 68, y: 22, w: 12, h: 8, page: 1 },
  { text: 'Toronto', x: 10, y: 34, w: 50, h: 8, page: 1 },
  { text: 'ON', x: 62, y: 34, w: 14, h: 8, page: 1 },
  { text: 'A1A', x: 82, y: 34, w: 18, h: 8, page: 1 },
  { text: '1A1', x: 104, y: 34, w: 18, h: 8, page: 1 }
];
const nameSnap = { x: 6, y: 8, w: 130, h: 12, page: 1 };
const salespersonOpts = StaticFieldPipeline.normalizeOptions({ isMultiline: false, staticPad: 1 });
const customerNameOpts = StaticFieldPipeline.normalizeOptions({ isMultiline: false, staticPad: 1 });
const customerAddressOpts = StaticFieldPipeline.normalizeOptions({
  isMultiline: true,
  staticPad: 5,
  lineMetrics: { lineCount: 3, lineHeights: { median: 8 } },
  lineCount: 3,
  lineHeights: { median: 8 }
});

const salespersonAssembly = StaticFieldPipeline.assembleForRun({ tokens: nameTokens, snapBox: nameSnap, options: salespersonOpts, minOverlap: 0.5 });
const customerNameAssembly = StaticFieldPipeline.assembleForRun({ tokens: nameTokens, snapBox: nameSnap, options: customerNameOpts, minOverlap: 0.5 });
const customerAddressAssembly = StaticFieldPipeline.assembleForRun({ tokens: nameTokens, snapBox: nameSnap, options: customerAddressOpts, minOverlap: 0.5 });

assert.strictEqual(salespersonAssembly.text, 'Alice Smith');
assert.strictEqual(customerNameAssembly.text, 'Alice Smith');
assert.ok(customerAddressAssembly.text.includes('\n'));
assert.strictEqual(customerAddressAssembly.text.split('\n').length, 3);
assert.deepStrictEqual(salespersonAssembly.box, customerNameAssembly.box);
assert.ok(customerAddressAssembly.box.h > salespersonAssembly.box.h);

console.log('Static mode tests passed.');
