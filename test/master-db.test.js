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
    subtotal: '100.00',
    tax: '13.00',
    total: '113.00',
    discount: '5.00'
  },
  lineItems: [
    { sku: 'SKU1', description: 'Item One', quantity: '2', unit_price: '20.00', amount: '40.00' },
    { sku: 'SKU2', description: 'Item Two', quantity: '1', unit_price: '60.00' }
  ]
}];

const rows = MasterDB.flatten(sampleDb);
assert.deepStrictEqual(rows[0], MasterDB.HEADERS);
assert.strictEqual(rows.length, 3);
assert.strictEqual(rows[1][0], 'My Store');
assert.strictEqual(rows[1][7], '1');
assert.strictEqual(rows[2][7], '2');
assert.strictEqual(rows[1][8], 'SKU1');
assert.strictEqual(rows[2][8], 'SKU2');
assert.strictEqual(rows[2][12], '60.00'); // computed line total
assert.strictEqual(rows[1][13], '100.00'); // subtotal repeated

const csv = MasterDB.toCsv(sampleDb);
assert.ok(csv.startsWith('Store / Business Name'));
assert.ok(csv.split('\n').length === 3);

console.log('MasterDB tests passed.');
