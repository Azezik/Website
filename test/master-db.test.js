const assert = require('assert');
const MasterDB = require('../master-db.js');

const ssot = {
  fields: {
    store_name: { value: ' My Store ' },
    department_division: { value: 'Electronics\nDivision' },
    invoice_number: { value: 'INV-001 ' },
    invoice_date: { value: '2024-01-05' },
    salesperson_rep: { value: ' Alice Smith ' },
    customer_name: { value: 'Bob Buyer' },
    customer_address: { value: '123 Main St\nSuite 5' },
    subtotal_amount: { value: '1050' },
    discounts_amount: { value: '10.5' },
    tax_amount: { value: '135.75' },
    invoice_total: { value: '1175.25' },
    payment_method: { value: 'Credit\nCard' },
    payment_status: { value: 'Paid' }
  },
  lineItems: [
    { sku: '0001', description: 'Widget A\nLarge', quantity: '2', unit_price: '100.5', amount: '201', line_no: '0001' },
    { sku: '0002', description: 'Widget B', quantity: '3', unit_price: '50', amount: '', line_no: ' ', __missing: { line_no: true } }
  ]
};

const { rows, missingMap } = MasterDB.flatten(ssot);
assert.deepStrictEqual(rows[0], MasterDB.HEADERS);
assert.strictEqual(rows.length, 3);
assert.strictEqual(rows[1][0], 'My Store');
assert.strictEqual(rows[1][1], 'Electronics Division');
assert.strictEqual(rows[1][2], 'INV-001');
assert.strictEqual(rows[1][3], '2024-01-05');
assert.strictEqual(rows[1][4], 'Alice Smith');
assert.strictEqual(rows[1][6], '123 Main St Suite 5');
assert.strictEqual(rows[1][7], '0001');
assert.strictEqual(rows[1][8], 'Widget A Large');
assert.strictEqual(rows[1][9], '2.00');
assert.strictEqual(rows[1][10], '100.50');
assert.strictEqual(rows[1][11], '201.00');
assert.strictEqual(rows[1][12], '1050.00');
assert.strictEqual(rows[1][13], '10.50');
assert.strictEqual(rows[1][14], '135.75');
assert.strictEqual(rows[1][15], '1175.25');
assert.strictEqual(rows[1][16], 'Credit Card');
assert.strictEqual(rows[1][17], 'Paid');
assert.strictEqual(rows[1][18], '0001');

assert.strictEqual(rows[2][7], '0002');
assert.strictEqual(rows[2][9], '3.00');
assert.strictEqual(rows[2][10], '50.00');
assert.strictEqual(rows[2][11], '150.00');
assert.strictEqual(rows[2][18], '2');

assert.deepStrictEqual(missingMap.summary, {
  sku: [],
  quantity: [],
  unit_price: [],
  line_no: [2]
});

assert.ok(missingMap.rows['2']);
assert.deepStrictEqual(missingMap.rows['2'].line_no.reasons, ['empty', 'flagged']);
assert.strictEqual(missingMap.rows['2'].line_no.flagged, true);
assert.deepStrictEqual(missingMap.columns.line_no.rows, [2]);
assert.deepStrictEqual(missingMap.columns.line_no.details['2'], missingMap.rows['2'].line_no);

assert.strictEqual(ssot.lineItems[1].line_no, ' ');

const csv1 = MasterDB.toCsv(ssot);
const csv2 = MasterDB.toCsv(ssot);
assert.strictEqual(csv1, csv2);
assert.strictEqual(csv1.split('\n').length, rows.length);

assert.throws(() => MasterDB.toCsv({ fields: {}, lineItems: [] }), /Exporter input empty—SSOT not wired./);

const noisyLineItems = [];
for(let i = 1; i <= 8; i++){
  noisyLineItems.push({
    sku: `SKU-${i}`,
    description: `Item ${i}`,
    quantity: String(i),
    unit_price: (10 * i).toString(),
    amount: (10 * i * i).toString(),
    line_no: String(i).padStart(4, '0'),
    __rowNumber: i
  });
}
noisyLineItems.push({
  sku: '',
  description: '',
  quantity: '',
  unit_price: '',
  amount: '',
  line_no: '0099',
  __rowNumber: 99
});
noisyLineItems.push({
  sku: '',
  description: '',
  quantity: '',
  unit_price: '',
  amount: '',
  line_no: '0100',
  __rowNumber: 100
});

const noisySsot = { fields: ssot.fields, lineItems: noisyLineItems };
const { rows: noisyRows, missingMap: noisyMissing } = MasterDB.flatten(noisySsot);

assert.strictEqual(noisyRows.length, 9);
assert.strictEqual(noisyRows.slice(1).length, 8);
assert.strictEqual(noisyRows[noisyRows.length - 1][18], '0008');
assert.deepStrictEqual(
  noisyRows.slice(1).map(row => row[7]),
  noisyLineItems.slice(0, 8).map(item => item.sku)
);
assert.ok(!('99' in noisyMissing.rows));
assert.ok(!('100' in noisyMissing.rows));

const inflatedNoise = [];
for(let i = 0; i < 6; i++){
  const idx = i + 9;
  inflatedNoise.push({
    sku: '',
    description: `Noise row ${idx}`,
    quantity: '',
    unit_price: String(5 * idx),
    amount: String(7 * idx),
    line_no: String(idx).padStart(4, '0'),
    __rowNumber: idx
  });
}

const inflatedSsot = {
  fields: ssot.fields,
  lineItems: noisyLineItems.slice(0, 8).concat(inflatedNoise)
};

const { rows: inflatedRows } = MasterDB.flatten(inflatedSsot);

assert.strictEqual(inflatedRows.length, 9);
assert.deepStrictEqual(
  inflatedRows.slice(1).map(row => row[7]),
  noisyLineItems.slice(0, 8).map(item => item.sku)
);

console.log('MasterDB tests passed.');
