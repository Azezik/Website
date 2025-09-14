const assert = require('assert');
const MasterDB = require('../master-db.js');

const sampleDb = [{
  invoice: {
    number: 'INV001',
    salesDateISO: '2024-01-05',
    salesperson: 'Alice',
    store: 'My Store'
  },
  fields: {
    department_division: { value: 'Electronics' },
    customer_name: { value: 'Bob' },
    customer_address: { value: '123 Main St' },
    payment_method: { value: 'Credit Card' },
    payment_status: { value: 'Paid' }
  },
  totals: {
    subtotal: '1,240.00',
    tax: '161.20',
    total: '1,401.20',
    discount: '5.00'
  },
  lineItems: [
    { sku: 'SKU1', description: 'Item One', quantity: '2', unit_price: '20.00', amount: '40.00' },
    { sku: 'SKU2', description: 'Item Two', quantity: '1', unit_price: '1,200.00' }
  ]
}];

const rows = MasterDB.flatten(sampleDb);
assert.deepStrictEqual(rows[0], MasterDB.HEADERS);
assert.strictEqual(rows.length, 3);
assert.strictEqual(rows[1][0], 'My Store');
assert.strictEqual(rows[1][18], '1');
assert.strictEqual(rows[2][18], '2');
assert.strictEqual(rows[1][7], 'SKU1');
assert.strictEqual(rows[2][7], 'SKU2');
assert.strictEqual(rows[2][10], '1200.00'); // cleaned unit price
assert.strictEqual(rows[2][11], '1200.00'); // computed line total
assert.strictEqual(rows[1][12], '1240.00'); // subtotal repeated

const misaligned = MasterDB.flatten([{ item_code: ['A'], item_description: ['B', 'C'], qty: ['1'], unit_price: ['10'] }]);
assert.strictEqual(misaligned.length, 2);
assert.strictEqual(misaligned[1][7], 'A');
assert.strictEqual(misaligned[1][8], 'B');

const csv = MasterDB.toCsv(sampleDb);
assert.ok(csv.startsWith('Store / Business Name'));
assert.ok(csv.split('\n').length === 3);

const textDb = [{
  invoice: { number: 'INV002', salesDateISO: '2024-02-10' },
  item_code: ['A1\nB2'],
  item_description: ['First item\nSecond item'],
  qty: ['1\n2'],
  unit_price: ['10\n20'],
  line_number: ['1\n2']
}];
const rows2 = MasterDB.flatten(textDb);
assert.strictEqual(rows2.length, 3);
assert.strictEqual(rows2[1][7], 'A1');
assert.strictEqual(rows2[2][7], 'B2');
assert.strictEqual(rows2[2][18], '2');

console.log('MasterDB tests passed.');
