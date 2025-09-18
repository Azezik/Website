const assert = require('assert');
const FieldMap = require('../field-map.js');

const fm = new FieldMap();
fm.upsert('doc1',{fieldKey:'a', value:'1', confidence:0.8, ts:1});
fm.upsert('doc1',{fieldKey:'a', value:'2', confidence:0.6, ts:2});
assert.strictEqual(fm.get('doc1')[0].value,'1');
fm.upsert('doc1',{fieldKey:'a', value:'3', confidence:0.8, ts:3});
assert.strictEqual(fm.get('doc1')[0].value,'3');
fm.upsert('doc1',{fieldKey:'b', value:'x', confidence:0.4, ts:4});
assert.strictEqual(fm.get('doc1').length,2);
console.log('FieldMap tests passed.');
