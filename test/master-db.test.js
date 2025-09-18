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

console.log('MasterDB tests passed.');
