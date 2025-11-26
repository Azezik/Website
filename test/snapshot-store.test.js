const assert = require('assert');
const SnapshotStore = require('../snapshot-store.js');

function fakeDataUrl(bytes){
  const buf = Buffer.alloc(bytes, 1);
  const b64 = buf.toString('base64');
  return `data:image/png;base64,${b64}`;
}

async function main(){
  const store = new SnapshotStore({ maxBytes: 64, maxPages: 2 });
  const small = fakeDataUrl(32);
  const big = fakeDataUrl(128);

  store.set('fileA', { id:'fileA:snap', fileId:'fileA', pages:[], overlays:{ boxes:true } });
  store.upsertPage('fileA', { pageNumber:1, dataUrl: small, thumbUrl: small });
  let manifest = store.get('fileA');
  assert.strictEqual(manifest.pages.length, 1);
  assert.ok(manifest.pages[0].dataUrl.startsWith('data:image/png'));
  assert.strictEqual(manifest.pages[0].tooLarge, undefined);

  store.upsertPage('fileA', { pageNumber:2, dataUrl: big, thumbUrl: big });
  manifest = store.get('fileA');
  const capped = manifest.pages.find(p => p.pageNumber === 2);
  assert.strictEqual(capped.dataUrl, null, 'large pages should be capped');
  assert.ok(capped.tooLarge, 'tooLarge flag set when capped');

  store.upsertPage('fileA', { pageNumber:3, dataUrl: small, thumbUrl: small });
  manifest = store.get('fileA');
  assert.strictEqual(manifest.pages.some(p => p.pageNumber === 3), false, 'page limit respected');

  console.log('Snapshot store tests passed.');
}

main();
