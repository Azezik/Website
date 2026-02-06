const assert = require('assert');
const ChartReady = require('../chart-ready.js');

const csv = [
  'event_date,money_in,money_out,gross_or_total,ytd_total,doc_id',
  '2024-01-03,100,20,80,80,A',
  '2024-01-02,50,10,40,40,B',
  'bad-date,1,2,3,4,C',
  '2024-01-04,120,30,90,170,A'
].join('\n');

const out = ChartReady.fromCsvText(csv, { source: 'upload' });
assert.strictEqual(out.source, 'upload');
assert.strictEqual(out.summary.totalRowsRead, 4);
assert.strictEqual(out.summary.rowsUsed, 2);
assert.strictEqual(out.summary.rowsExcludedInvalidEventDate, 1);
assert.strictEqual(out.summary.dedupeCollisionsResolved, 1);
assert.strictEqual(out.invalidRows.length, 1);
assert.deepStrictEqual(out.events.map(e => e.doc_id), ['B', 'A']);
assert.deepStrictEqual(out.datasets.money_in.map(p => p.y), [50, 120]);
assert.deepStrictEqual(out.datasets.ytd_total.map(p => p.y), [40, 170]);

const missing = ChartReady.fromCsvText('event_date,money_in\n2024-01-01,10');
assert.ok(missing.errors.some(e => /Missing required column: money_out/.test(e)));
