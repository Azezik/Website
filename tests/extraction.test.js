const test = require('node:test');
const assert = require('assert');
const { tokensInRect } = require('../ocr');
const { FieldMap } = require('../ui');
const { DocumentExtractor, mergeLineItems, reconcileTotals, TemplateStore } = require('../invoice-wizard');
const config = require('../config');

// Boundary-only extraction
 test('boundary-only extraction without anchor leakage', () => {
   const tokens = [
     {text:'N97897', x0:10,y0:10,x1:60,y1:20},
     {text:'Salesperson', x0:70,y0:10,x1:150,y1:20}
   ];
   const rect = {x0:5,y0:5,x1:65,y1:25};
   const val = tokensInRect(tokens, rect);
   assert.strictEqual(val, 'N97897');
 });

 // Deduping fields
 test('field map deduping', () => {
   const map = new FieldMap();
   map.upsert('invoiceNumber', {value:'A1'});
   map.upsert('invoiceNumber', {value:'A1'});
   assert.strictEqual(map.rows().length,1);
   map.upsert('invoiceNumber', {value:'B2'});
   assert.strictEqual(map.rows().length,1);
   assert.strictEqual(map.get('invoiceNumber').value,'B2');
 });

 // Relative zone with padding
 test('relative zone extraction tolerates drift', () => {
   const extractor = new DocumentExtractor(config);
   extractor.loadProfile({ zones:{ invoiceNumber:{ page:0, rect:{x:0.1,y:0.1,w:0.2,h:0.05} } } });
   const page = { width:100, height:100, tokens:[{text:'INV100', x0:12,y0:12,x1:42,y1:20}] };
   const spec = { fieldKey:'invoiceNumber', type:'invoiceNumber' };
   const res = extractor.extractField(spec, page, 0);
   assert.strictEqual(res.value,'INV100');
 });

 // Anchor search
 test('anchor-guided search extracts value', () => {
   const extractor = new DocumentExtractor(config);
   const page = {width:200,height:100,tokens:[
     {text:'Invoice', x0:10,y0:10,x1:50,y1:20},
     {text:'INV200', x0:60,y0:10,x1:120,y1:20}
   ]};
   const spec = { fieldKey:'invoiceNumber', type:'invoiceNumber', anchors:['Invoice'] };
   const res = extractor.extractField(spec, page, 0);
   assert.strictEqual(res.value,'INV200');
   assert.strictEqual(res.strategy, 'anchor');
 });

 // Pattern fallback
 test('pattern-based search fallback', () => {
   const extractor = new DocumentExtractor(config);
   const page = {width:200,height:100,tokens:[{text:'INV300', x0:100,y0:50,x1:150,y1:60}]};
   const spec = { fieldKey:'invoiceNumber', type:'invoiceNumber' };
   const res = extractor.extractField(spec, page, 0);
   assert.strictEqual(res.value,'INV300');
   assert.strictEqual(res.strategy, 'pattern');
 });

 // Totals validation
 test('arithmetic validation flags mismatch', () => {
   const extractor = new DocumentExtractor(config);
   extractor.fields.upsert('subtotal',{value:90});
   extractor.fields.upsert('tax',{value:10});
   extractor.fields.upsert('total',{value:101});
   reconcileTotals(extractor.fields, config);
   const total = extractor.fields.get('total');
   assert.strictEqual(total.status,'validation-error');
 });

 // Line items merge & dedupe
 test('line items merge wrapped descriptions and dedupe', () => {
   const items = [
     {desc:'Long', qty:1, price:10, amount:10, y:10, h:5},
     {desc:'description', qty:1, price:10, amount:10, y:15, h:5},
     {desc:'Another', qty:2, price:5, amount:10, y:40, h:5, confidence:1},
     {desc:'Another', qty:2, price:5, amount:10, y:45, h:5, confidence:0.5}
   ];
   const rows = mergeLineItems(items);
   assert.strictEqual(rows.length,2);
   assert.strictEqual(rows[0].description, 'Long description');
 });

 // Template family detection reuse
 test('template family detection reuses zones', () => {
   const store = new TemplateStore(config);
   const profile = { zones:{ invoiceNumber:{ page:0, rect:{x:0.1,y:0.1,w:0.2,h:0.05} } } };
   const doc1 = { pages:[{width:100,height:100,tokens:[]}] };
   const fp1 = store.fingerprint(doc1);
   store.register(fp1, profile);
   const extractor = new DocumentExtractor(config, store);
   const doc2 = { pages:[{width:100,height:100,tokens:[{text:'INV500', x0:12,y0:12,x1:40,y1:20}]}] };
   const fp2 = store.fingerprint(doc2);
   const prof = store.match(fp2);
   extractor.loadProfile(prof);
   const spec = { fieldKey:'invoiceNumber', type:'invoiceNumber' };
   const res = extractor.extractField(spec, doc2.pages[0], 0);
   assert.strictEqual(res.value,'INV500');
 });
