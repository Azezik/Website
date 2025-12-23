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

const totalsOnly = {
  fields: {
    invoice_total: { value: '250' },
    subtotal_amount: { value: '250' }
  },
  lineItems: []
};

const { rows: totalsOnlyRows, missingMap: totalsOnlyMissing } = MasterDB.flatten(totalsOnly);
assert.strictEqual(totalsOnlyRows.length, 2);
assert.strictEqual(totalsOnlyRows[1][8], 'Primary Item (single-item contract)');
assert.strictEqual(totalsOnlyRows[1][9], '1.00');
assert.strictEqual(totalsOnlyRows[1][10], '250.00');
assert.strictEqual(totalsOnlyRows[1][11], '250.00');
assert.strictEqual(totalsOnlyRows[1][18], '1');
assert.deepStrictEqual(totalsOnlyMissing.summary, {
  sku: [1],
  quantity: [],
  unit_price: [],
  line_no: []
});

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

const areaRecord = {
  ...ssot,
  fileId: 'file-area-1',
  masterDbConfig: {
    globalFields: [
      { fieldKey: 'invoice_number', label: 'Invoice #' }
    ]
  },
  areaRows: [
    { areaId: 'StoreFloor', fields: { aisle: { value: 'A1' }, shelf: { value: 'S1' } } },
    { areaId: 'StoreFloor', fields: { aisle: { value: 'A2' } } },
    {
      areaId: 'Backroom',
      fields: { bin: { value: 'B1' } },
      rows: [
        { fields: { bin: { value: 'B1-1' }, status: { value: 'ok' } } },
        { fields: { bin: { value: 'B1-2' } } }
      ]
    }
  ]
};

const { sheets } = MasterDB.flatten(areaRecord);
const rootSheet = sheets.find(s => s.name === 'MasterDB');
assert.ok(rootSheet, 'root sheet present');
const storeFloorSheet = sheets.find(s => s.areaId === 'StoreFloor');
assert.ok(storeFloorSheet, 'StoreFloor sheet present');
assert.deepStrictEqual(storeFloorSheet.header.slice(-1)[0], 'File ID');
assert.strictEqual(storeFloorSheet.rows.length, 1 + 2);
assert.deepStrictEqual(
  storeFloorSheet.rows[0],
  ['Invoice #', 'aisle', 'shelf', 'File ID']
);
assert.strictEqual(storeFloorSheet.rows[1][0], 'INV-001');
assert.strictEqual(storeFloorSheet.rows[1][1], 'A1');
assert.strictEqual(storeFloorSheet.rows[1][3], 'file-area-1');
assert.strictEqual(storeFloorSheet.rows[2][0], 'INV-001');

const backroomSheet = sheets.find(s => s.areaId === 'Backroom');
assert.ok(backroomSheet, 'Backroom sheet present');
assert.strictEqual(backroomSheet.rows.length, 1 + 2);
assert.deepStrictEqual(backroomSheet.header, ['Invoice #', 'bin', 'status', 'File ID']);
assert.strictEqual(backroomSheet.rows[2][2], '');
assert.strictEqual(backroomSheet.rows[2][3], 'file-area-1');

const areaOnlyRecord = {
  ...ssot,
  fileId: 'area-only',
  masterDbConfig: {
    globalFields: [
      { fieldKey: 'invoice_number', label: 'Invoice #' }
    ],
    areaFieldKeys: ['invoice_number'],
    documentFieldKeys: []
  },
  lineItems: [],
  areaRows: [
    { areaId: 'Floor', fields: { aisle: { value: 'C3' } } }
  ]
};

const { sheets: areaOnlySheets } = MasterDB.flatten(areaOnlyRecord);
const rootAreaOnlySheet = areaOnlySheets.find(s => s.name === 'MasterDB');
assert.ok(!rootAreaOnlySheet, 'root sheet omitted when fields are area-only');
const floorSheet = areaOnlySheets.find(s => s.areaId === 'Floor');
assert.ok(floorSheet, 'Floor sheet present');
assert.strictEqual(floorSheet.rows.length, 1 + 1);
assert.strictEqual(floorSheet.rows[1][0], 'INV-001');
assert.strictEqual(floorSheet.rows[1][1], 'C3');

const areaAliasRecord = {
  ...ssot,
  fileId: 'area-alias',
  masterDbConfig: {
    globalFields: [
      { fieldKey: 'invoice_number', label: 'Invoice #' }
    ],
    areas: [
      { id: 'ColdStorage', name: 'Cold Storage', aliases: ['Freezer'] }
    ]
  },
  lineItems: [],
  areaRows: [
    { areaId: 'coldstorage', areaName: 'Cold Storage', fields: { bin: { value: 'CS1' } } },
    { areaId: 'COLD STORAGE', areaName: 'cold storage', fields: { bin: { value: 'CS2' } } },
    { areaId: 'freezer', areaName: 'FREEZER', fields: { bin: { value: 'CS3' } } }
  ]
};

const { sheets: aliasSheets } = MasterDB.flatten(areaAliasRecord);
const coldStorageSheets = aliasSheets.filter(s => s.areaId === 'ColdStorage');
assert.strictEqual(coldStorageSheets.length, 1, 'Cold Storage sheet deduped');

const multiAreaRecords = [
  {
    fields: {
      invoice_number: { value: 'INV-A ' },
      store_name: { value: 'North Shop' }
    },
    fileId: 'file-multi-1',
    masterDbConfig: {
      globalFields: [
        { fieldKey: 'invoice_number', label: 'Invoice #' },
        { fieldKey: 'store_name', label: 'Store' }
      ]
    },
    areaRows: [
      { areaId: 'Zone', fields: { aisle: { value: 'Z1' } } },
      { areaId: 'Zone', fields: { aisle: { value: 'Z2' } } }
    ]
  },
  {
    fields: {
      invoice_date: { value: '2024-02-10' },
      invoice_number: { value: 'INV-B' }
    },
    fileId: 'file-multi-2',
    masterDbConfig: {
      globalFields: [
        { fieldKey: 'invoice_date', label: 'Invoice Date' }
      ]
    },
    areaRows: [
      { areaId: 'Zone', fields: { aisle: { value: 'Z3' } } },
      { areaId: 'Zone', fields: { aisle: { value: 'Z4' } } }
    ]
  }
];

const { sheets: multiAreaSheets } = MasterDB.flatten(multiAreaRecords);
const zoneSheet = multiAreaSheets.find(s => s.areaId === 'Zone');
assert.ok(zoneSheet, 'Zone sheet present for multi-doc records');
assert.deepStrictEqual(zoneSheet.header, ['Invoice #', 'Store', 'aisle', 'Invoice Date', 'File ID']);
assert.strictEqual(zoneSheet.rows.length, 1 + 4);
assert.deepStrictEqual(zoneSheet.rows[1], ['INV-A', 'North Shop', 'Z1', '', 'file-multi-1']);
assert.deepStrictEqual(zoneSheet.rows[2], ['INV-A', 'North Shop', 'Z2', '', 'file-multi-1']);
assert.deepStrictEqual(zoneSheet.rows[3], ['', '', 'Z3', '2024-02-10', 'file-multi-2']);
assert.deepStrictEqual(zoneSheet.rows[4], ['', '', 'Z4', '2024-02-10', 'file-multi-2']);
const coldStorageSheet = coldStorageSheets[0];
assert.strictEqual(coldStorageSheet.rows.length, 1 + 3);
assert.deepStrictEqual(
  coldStorageSheet.rows.slice(1).map(r => r[0]),
  ['INV-001', 'INV-001', 'INV-001']
);
assert.deepStrictEqual(
  coldStorageSheet.rows.slice(1).map(r => r[1]),
  ['CS1', 'CS2', 'CS3']
);

const schemaRecord = {
  fields: {
    invoice_number: { value: 'SCHEMA-100' }
  },
  fileId: 'schema-table',
  masterDbConfig: {
    globalFields: [
      { fieldKey: 'invoice_number', label: 'Invoice #' }
    ],
    areas: [
      {
        id: 'Warehouse',
        name: 'Warehouse',
        rowType: 'table',
        columns: [
          { fieldKey: 'aisle', label: 'Aisle' },
          { fieldKey: 'shelf', label: 'Shelf' },
          { fieldKey: 'bin', label: 'Bin' }
        ]
      }
    ]
  },
  areaRows: [
    { areaId: 'Warehouse', rows: [
      { fields: { Aisle: { value: 'A' }, Shelf: { value: 'S1' } } },
      { fields: { Aisle: { value: 'B' }, Bin: { value: 'B2' } } }
    ] }
  ]
};

const { sheets: schemaSheets } = MasterDB.flatten(schemaRecord);
const warehouseSheet = schemaSheets.find(s => s.areaId === 'Warehouse');
assert.ok(warehouseSheet, 'warehouse sheet present');
assert.deepStrictEqual(warehouseSheet.header, ['Invoice #', 'Aisle', 'Shelf', 'Bin', 'File ID']);
assert.deepStrictEqual(warehouseSheet.rows[1], ['SCHEMA-100', 'A', 'S1', '', 'schema-table']);
assert.deepStrictEqual(warehouseSheet.rows[2], ['SCHEMA-100', 'B', '', 'B2', 'schema-table']);
assert.strictEqual(warehouseSheet.rows.length, 3);

assert.throws(() => MasterDB.flatten({
  ...schemaRecord,
  areaRows: [
    { areaId: 'Warehouse', fields: { Aisle: { value: 'C' }, Extra: { value: '??' } } }
  ]
}), /Unexpected columns/);

const blockSchemaRecord = {
  fields: {
    invoice_number: { value: 'BLOCK-1' }
  },
  fileId: 'schema-block',
  masterDbConfig: {
    globalFields: [
      { fieldKey: 'invoice_number', label: 'Invoice #' }
    ],
    areas: [
      {
        id: 'Placard',
        name: 'Placard',
        rowType: 'block',
        columns: [
          { fieldKey: 'message', label: 'Message' },
          { fieldKey: 'status', label: 'Status' }
        ]
      }
    ]
  },
  areaRows: [
    { areaId: 'Placard', fields: { Message: { value: 'Hello' } } },
    { areaId: 'Placard', fields: { Status: { value: 'Green' } } }
  ]
};

const { sheets: blockSheets } = MasterDB.flatten(blockSchemaRecord);
const placardSheet = blockSheets.find(s => s.areaId === 'Placard');
assert.ok(placardSheet, 'placard sheet present');
assert.deepStrictEqual(placardSheet.header, ['Invoice #', 'Message', 'Status', 'File ID']);
assert.strictEqual(placardSheet.rows.length, 1 + 2);
assert.deepStrictEqual(
  placardSheet.rows.slice(1),
  [
    ['BLOCK-1', 'Hello', '', 'schema-block'],
    ['BLOCK-1', '', 'Green', 'schema-block']
  ]
);

console.log('MasterDB tests passed.');
