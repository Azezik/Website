const assert = require('assert');
const { runBaseOcrMagic } = require('../ocrmagic-layer1.js');

function correct(input){
  const res = runBaseOcrMagic(input);
  return typeof res === 'string' ? res : res.cleaned;
}

function appliedRules(input){
  const res = runBaseOcrMagic(input);
  return res.rulesApplied || [];
}

assert.strictEqual(correct('Kno11sbrook'), 'Knollsbrook');
assert.deepStrictEqual(appliedRules('Kno11sbrook'), ['layer1-common-substitution']);

assert.strictEqual(correct('Knol1sbrook'), 'Knollsbrook');
assert.deepStrictEqual(appliedRules('Knol1sbrook'), ['layer1-common-substitution']);

assert.strictEqual(correct('S520'), 'SS20');
assert.deepStrictEqual(appliedRules('S520'), ['layer1-common-substitution']);

assert.strictEqual(correct('BBP0311@gmail.com'), 'BBP0311@gmail.com');
assert.deepStrictEqual(appliedRules('BBP0311@gmail.com'), []);

assert.strictEqual(correct('K2J 1K8'), 'K2J 1K8');
assert.deepStrictEqual(appliedRules('K2J 1K8'), []);

const fullAddress = '60 Knollsbrook Dr, Barhaven, Ontario, K2J 1K8';
assert.strictEqual(correct(fullAddress), fullAddress);
assert.deepStrictEqual(appliedRules(fullAddress), []);

const regressionInput = 'Knollsbrook';
assert.strictEqual(correct(regressionInput), regressionInput);
assert.deepStrictEqual(appliedRules(regressionInput), []);

const magicDataTypeIrrelevant = 'Knol1sbrook';
assert.strictEqual(correct(magicDataTypeIrrelevant), 'Knollsbrook');


console.log('OCRMAGIC Layer 1 tests passed.');
