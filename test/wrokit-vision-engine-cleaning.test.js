const assert = require('assert');
const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine.js');

(function run(){
  const tokens = [
    { text: 'Total', x: 100, y: 100, w: 60, h: 18, page: 1 },
    { text: '$II5OO', x: 170, y: 100, w: 80, h: 18, page: 1 },
    { text: 'Invoice', x: 100, y: 140, w: 70, h: 18, page: 1 },
    { text: 'O1/O8/2O24', x: 180, y: 140, w: 110, h: 18, page: 1 }
  ];
  const viewport = { width: 1000, height: 1000, w: 1000, h: 1000 };

  const numericResult = WrokitVisionEngine.extractScalar({
    fieldSpec: { fieldKey: 'invoice_total', magicDataType: 'numeric' },
    tokens,
    boxPx: { x: 90, y: 90, w: 180, h: 30, page: 1 },
    viewport
  });
  assert.strictEqual(numericResult.value, '11500', 'numeric field should normalize OCR digit confusions');
  assert.ok(Array.isArray(numericResult.correctionsApplied), 'numeric result should surface corrections list');

  const dateResult = WrokitVisionEngine.extractScalar({
    fieldSpec: { fieldKey: 'invoice_date' },
    tokens,
    boxPx: { x: 90, y: 130, w: 260, h: 30, page: 1 },
    viewport
  });
  assert.strictEqual(dateResult.value, '01/08/2024', 'date field should normalize OCR date confusions');

  console.log('wrokit vision type-aware cleaning test passed');
})();
