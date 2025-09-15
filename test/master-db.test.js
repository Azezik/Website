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
assert.strictEqual(misaligned.length, 3);
assert.strictEqual(misaligned[1][7], 'A');
assert.strictEqual(misaligned[1][8], 'B');
assert.strictEqual(misaligned[2][8], 'C');
assert.strictEqual(misaligned[1][18], '1');
assert.strictEqual(misaligned[2][18], '2');

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

const altFieldsDb = [{
  invoice: { number: 'INV003', salesDateISO: '2024-03-01' },
  sku: ['S1', 'S2'],
  product_description: ['Thing 1', 'Thing 2'],
  line_number: ['001', '002']
}];
const rows3 = MasterDB.flatten(altFieldsDb);
assert.strictEqual(rows3.length, 3);
assert.strictEqual(rows3[1][7], 'S1');
assert.strictEqual(rows3[2][8], 'Thing 2');
assert.strictEqual(rows3[2][18], '002');

const columnObjectDb = [{
  invoice: { number: 'INV004', salesDateISO: '2024-03-02' },
  lineItems: {
    item_code: ['C1', 'C2', 'C3'],
    item_description: ['First', 'Second', 'Third'],
    qty: ['1', '2', '3'],
    unit_price: ['5', '6', '7'],
    line_total: ['5', '12', '21']
  }
}];
const rows4 = MasterDB.flatten(columnObjectDb);
assert.strictEqual(rows4.length, 4);
assert.strictEqual(rows4[1][7], 'C1');
assert.strictEqual(rows4[3][8], 'Third');
assert.strictEqual(rows4[3][11], '21.00');
assert.strictEqual(rows4[2][18], '2');

const messyDb = [{
  invoice: {
    number: ' INV004 ',
    salesDateISO: '2024-04-01\n',
    salesperson: '  Jane Doe  ',
    store: 'STORE\nNAME'
  },
  fields: {
    department_division: { value: 'North\nRegion' },
    customer_name: { value: 'Customer\nName' },
    customer_address: { value: '50 CLUB\nPISCINE NEPEAN' },
    payment_method: { value: 'Pay\nLater' },
    payment_status: { value: 'Paid\n' }
  },
  lineItems: [
    { sku: ' 001 ', description: 'Widget\nLarge', quantity: '2', unit_price: '5', amount: '10' }
  ]
}];
const messyRows = MasterDB.flatten(messyDb);
assert.strictEqual(messyRows.length, 2);
assert.strictEqual(messyRows[1][0], 'STORE NAME');
assert.strictEqual(messyRows[1][1], 'North Region');
assert.strictEqual(messyRows[1][2], 'INV004');
assert.strictEqual(messyRows[1][3], '2024-04-01');
assert.strictEqual(messyRows[1][5], 'Customer Name');
assert.strictEqual(messyRows[1][6], '50 CLUB PISCINE NEPEAN');
assert.strictEqual(messyRows[1][7], '001');
assert.strictEqual(messyRows[1][8], 'Widget Large');
assert.strictEqual(messyRows[1][16], 'Pay Later');
assert.ok(!/\n/.test(messyRows[1].join('')));

console.log('MasterDB tests passed.');
