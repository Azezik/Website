const assert = require('assert');
const layer1 = require('../ocrmagic-layer1.js');
const pipeline = require('../ocr-magic-pipeline.js');

const { station1_layer1Adjacency } = layer1;
const {
  station2_magicType,
  station3_fingerprintAndScore,
  station4_applyFingerprintFixes,
  SegmentModelStore,
  MAGIC_DATA_TYPE
} = pipeline;

const station1 = station1_layer1Adjacency || layer1.runBaseOcrMagic;

// Station 1
const l1 = station1('Ro11ing');
assert.strictEqual(l1.l1Text || l1.cleaned, 'Rolling');

const noLetterToDigit = station1('I0I');
assert.strictEqual(noLetterToDigit.l1Text || noLetterToDigit.cleaned, 'IOI');
const letterStayed = station1('OIO');
assert.strictEqual(letterStayed.l1Text || letterStayed.cleaned, 'OIO');

// Station 2
const s2Any = station2_magicType('0LGA', MAGIC_DATA_TYPE.ANY);
assert.strictEqual(s2Any.typedText, '0LGA');

const s2Text = station2_magicType('0LGA', MAGIC_DATA_TYPE.TEXT);
assert.strictEqual(s2Text.typedText, 'OLGA');

const s2Num = station2_magicType('O', MAGIC_DATA_TYPE.NUMERIC);
assert.strictEqual(s2Num.typedText, '0');

// Station 3 + 4 DV path
const store = new SegmentModelStore('test-ocrmagic', { persist: false });
const ctx = { wizardId: 'wiz', fieldName: 'sample', magicType: MAGIC_DATA_TYPE.ANY, segmenterConfig: { segments: [{ id: 'full', strategy: 'full' }] } };

for (let i = 0; i < 4; i++) {
  station3_fingerprintAndScore('A2B3C4', ctx, store);
}

let stage3 = station3_fingerprintAndScore('KOA 1XO', ctx, store);
assert.strictEqual(stage3.segments[0].deliberateViolation, false);

stage3 = station3_fingerprintAndScore('KOA 1XO', ctx, store);
assert.strictEqual(stage3.segments[0].deliberateViolation, true);

const stage4 = station4_applyFingerprintFixes('KOA 1XO', stage3, ctx);
assert.strictEqual(stage4.finalText, 'K0A 1X0');

console.log('OCRMAGIC pipeline tests passed.');
