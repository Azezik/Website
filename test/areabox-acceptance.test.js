const assert = require('assert');
const MasterDB = require('../master-db.js');
const { findAreaOccurrencesForPage } = require('../tools/areafinder.js');
const { tokensInBox } = require('../tools/static-field-mode.js');
const { normalizeKeywordText } = require('../tools/keyword-weighting.js');

function orientationFromBoxes(areaBox, tokenBox, role){
  const normText = normalizeKeywordText ? normalizeKeywordText(`corner ${role}`) : `corner ${role}`;
  return {
    role,
    normText,
    edgeOffsets: {
      left: (tokenBox.x - areaBox.x) / areaBox.w,
      right: (areaBox.x + areaBox.w - (tokenBox.x + tokenBox.w)) / areaBox.w,
      top: (tokenBox.y - areaBox.y) / areaBox.h,
      bottom: (areaBox.y + areaBox.h - (tokenBox.y + tokenBox.h)) / areaBox.h
    }
  };
}

function buildAreaBundle(areaBox, pageW, pageH){
  const topRightToken = {
    x: areaBox.x + areaBox.w * 0.7,
    y: areaBox.y + areaBox.h * 0.05,
    w: areaBox.w * 0.25,
    h: areaBox.h * 0.15,
    page: 1
  };
  const bottomLeftToken = {
    x: areaBox.x + areaBox.w * 0.05,
    y: areaBox.y + areaBox.h * 0.75,
    w: areaBox.w * 0.2,
    h: areaBox.h * 0.2,
    page: 1
  };
  const fp = {
    page: 1,
    bboxPct: {
      x0: areaBox.x / pageW,
      y0: areaBox.y / pageH,
      x1: (areaBox.x + areaBox.w) / pageW,
      y1: (areaBox.y + areaBox.h) / pageH
    },
    orientation: {
      topRight: orientationFromBoxes(areaBox, topRightToken, 'topRight'),
      bottomLeft: orientationFromBoxes(areaBox, bottomLeftToken, 'bottomLeft')
    }
  };
  const tokens = [
    { ...topRightToken, text: fp.orientation.topRight.normText },
    { ...bottomLeftToken, text: fp.orientation.bottomLeft.normText }
  ];
  return { fp, tokens };
}

function basicRecord(fileId){
  return {
    fileId,
    fields: {
      store_name: { value: 'Test Store' },
      invoice_number: { value: `INV-${fileId}` },
      invoice_total: { value: '100' },
      subtotal_amount: { value: '100' },
      invoice_date: { value: '2024-02-02' }
    },
    lineItems: [
      { sku: 'SKU-1', description: 'Widget', quantity: '1', unit_price: '100', amount: '100', line_no: '1' }
    ]
  };
}

(function rootOnly(){
  const { sheets } = MasterDB.flatten(basicRecord('ROOT-ONLY'));
  assert.deepStrictEqual(sheets.map(s => s.name), ['MasterDB']);
})();

(function areasOnly(){
  const areaOnly = {
    fileId: 'AREA-ONLY',
    fields: {},
    lineItems: [],
    areaRows: [
      { areaId: 'Zone', fields: { slot: { value: 'Z1' } } },
      { areaId: 'Zone', fields: { slot: { value: 'Z2' } } }
    ]
  };

  const { sheets } = MasterDB.flatten(areaOnly);
  assert.ok(sheets.every(s => s.areaId), 'only area sheets emitted');
  const sheet = sheets.find(s => s.areaId === 'Zone');
  assert.ok(sheet, 'area sheet emitted');
  assert.strictEqual(sheet.rows.length, 3);
  assert.ok(sheet.header.includes('File ID'));
})();

(function mixedWithMultipleAreas(){
  const record = {
    ...basicRecord('MIXED-1'),
    areaRows: [
      { areaId: 'FloorA', fields: { aisle: { value: '1' } } },
      { areaId: 'FloorB', fields: { aisle: { value: '2' } } }
    ]
  };

  const { sheets } = MasterDB.flatten(record);
  const names = sheets.map(s => s.areaId || s.name);
  assert.ok(names.includes('FloorA') && names.includes('FloorB'));
  const master = sheets.find(s => s.name === 'MasterDB');
  assert.ok(master.rows.length > 1, 'root sheet preserved when root data exists');
  sheets.forEach(sheet => {
    const dataRows = sheet.rows.slice(1);
    dataRows.forEach(row => {
      assert.notStrictEqual(row.join('').trim(), '', 'no divider rows');
      assert.strictEqual(row.length, sheet.header.length);
    });
  });
})();

(function repeatedTransactionArea(){
  const record = {
    ...basicRecord('TRANSACT-1'),
    areaRows: [
      {
        areaId: 'Transaction',
        rows: [
          { fields: { item: { value: 'Line A' } } },
          { fields: { item: { value: 'Line B' } } },
          { fields: { item: { value: 'Line C' } } }
        ]
      }
    ]
  };

  const { sheets } = MasterDB.flatten(record);
  const txSheet = sheets.find(s => s.areaId === 'Transaction');
  assert.ok(txSheet, 'transaction sheet present');
  const ids = new Set(txSheet.rows.slice(1).map(r => r[r.length - 1]));
  assert.strictEqual(ids.size, 1, 'file id repeated for each area occurrence');
  assert.strictEqual(txSheet.rows.length, 4);
})();

(function globalFieldPropagation(){
  const record = {
    ...basicRecord('GLOBAL-1'),
    masterDbConfig: {
      globalFields: [
        { fieldKey: 'invoice_number', label: 'Invoice #' }
      ]
    },
    areaRows: [
      { areaId: 'StoreFloor', fields: { aisle: { value: 'A1' } } },
      { areaId: 'StoreFloor', fields: { aisle: { value: 'A2' } } }
    ]
  };

  const { sheets } = MasterDB.flatten(record);
  const storeSheet = sheets.find(s => s.areaId === 'StoreFloor');
  assert.ok(storeSheet.header.includes('Invoice #'));
  const invoiceCells = storeSheet.rows.slice(1).map(r => r[storeSheet.header.indexOf('Invoice #')]);
  assert.deepStrictEqual(invoiceCells, ['INV-GLOBAL-1', 'INV-GLOBAL-1']);
})();

(function coordinatesStayDocumentSpace(){
  const pageW = 800;
  const pageH = 600;
  const areaBox = { x: 50, y: 40, w: 200, h: 120 };
  const { fp, tokens } = buildAreaBundle(areaBox, pageW, pageH);
  const occurrences = findAreaOccurrencesForPage([{ areaId: 'Area', areaFingerprint: fp }], tokens, { pageW, pageH });
  assert.strictEqual(occurrences.length, 1);
  const bbox = occurrences[0].bboxPx;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(
    near(bbox.x, areaBox.x) && near(bbox.y, areaBox.y) && near(bbox.w, areaBox.w) && near(bbox.h, areaBox.h),
    'bbox stays in document space without re-scaling'
  );
})();

(function areasRestrictSearch(){
  const areaBox = { x: 0, y: 0, w: 100, h: 50, page: 1 };
  const tokens = [
    { text: 'inside', x: 10, y: 10, w: 20, h: 10, page: 1 },
    { text: 'outside', x: 150, y: 10, w: 20, h: 10, page: 1 }
  ];
  const hits = tokensInBox(tokens, areaBox, { minOverlap: 0 });
  assert.deepStrictEqual(hits.map(t => t.text), ['inside']);
})();

console.log('AREABOX acceptance checks passed.');
