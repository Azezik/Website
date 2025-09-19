const assert = require('assert');
const selectionFirst = require('../orchestrator.js');

function cleanFail(tokens){ return { value:'', raw:'', conf:0 }; }
function cleanOk(tokens){ return { value:'CLEAN', raw:'', conf:1 }; }

const tokens = [{text:'Foo'}, {text:'Bar'}];

const resFail = selectionFirst(tokens, cleanFail);
assert.strictEqual(resFail.raw, 'Foo Bar');
assert.strictEqual(resFail.value, 'Foo Bar');
assert.strictEqual(resFail.cleanedOk, false);
assert.ok(resFail.raw, 'raw should not be blank when cleaning fails');

const resOk = selectionFirst(tokens, cleanOk);
assert.strictEqual(resOk.raw, 'Foo Bar');
assert.strictEqual(resOk.value, 'CLEAN');
assert.strictEqual(resOk.cleanedOk, true);

console.log('All tests passed.');
