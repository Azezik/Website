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

// Segment extraction - address
const addrCtx = { wizardId: 'wiz', fieldName: 'shipping_address' };
const addrStage = station3_fingerprintAndScore('3031 Councillors Way, Ottawa, Ontario, KI7 272', addrCtx, store);
assert.strictEqual(addrStage.segments.length, 2);
assert.strictEqual(addrStage.segments[0].segmentId, 'address:first2');
assert.strictEqual(addrStage.segments[0].rawSegmentText, '3031 Councillors');
assert.strictEqual(addrStage.segments[1].segmentId, 'address:last2');
assert.strictEqual(addrStage.segments[1].rawSegmentText, 'KI7 272');

const addrShort = station3_fingerprintAndScore('K2W 1A3', addrCtx, store);
assert.strictEqual(addrShort.segments.length, 1);
assert.strictEqual(addrShort.segments[0].rawSegmentText, 'K2W 1A3');

const addrOverlap = station3_fingerprintAndScore('6 Maley Lane, Kanata, Ontario K2W 1A3 Bob MacDonald', addrCtx, store);
assert.strictEqual(addrOverlap.segments.length, 2);
assert.strictEqual(addrOverlap.segments[0].rawSegmentText, '6 Maley');
assert.strictEqual(addrOverlap.segments[1].rawSegmentText, 'Bob MacDonald');

// Segment extraction - non-address defaults to full
const nonAddrCtx = { wizardId: 'wiz', fieldName: 'invoice_number' };
const nonAddrStage = station3_fingerprintAndScore('INV-12345', nonAddrCtx, store);
assert.strictEqual(nonAddrStage.segments.length, 1);
assert.strictEqual(nonAddrStage.segments[0].segmentId, 'full');
assert.strictEqual(nonAddrStage.segments[0].rawSegmentText, 'INV-12345');

console.log('OCRMAGIC pipeline tests passed.');
