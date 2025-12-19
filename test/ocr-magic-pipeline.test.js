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

// Station 3 + 4 DV path (structural mixed adjacency)
const store = new SegmentModelStore('test-ocrmagic', { persist: false });
const ctx = { wizardId: 'wiz', fieldName: 'sample', magicType: MAGIC_DATA_TYPE.ANY, segmenterConfig: { segments: [{ id: 'full', strategy: 'full' }] } };

for (let i = 0; i < 4; i++) {
  station3_fingerprintAndScore('A2B3C4', ctx, store);
}

let stage3 = station3_fingerprintAndScore('A2B3C4', ctx, store);
assert.strictEqual(stage3.segments[0].deliberateViolation, true);
assert.ok(stage3.segments[0].hasAnyMixed);
assert.ok(stage3.segments[0].hasMixedAdjacency);

stage3 = station3_fingerprintAndScore('1 2 1 2 1 2', ctx, store);
const stage4 = station4_applyFingerprintFixes('1 2 1 2 1 2', stage3, ctx);
assert.strictEqual(stage4.finalText, 'I 2 I 2 I 2');

// PCS gating - allow close match corrections
const pcsStore = new SegmentModelStore('test-ocrmagic-pcs', { persist: false });
const pcsCtx = { wizardId: 'wiz', fieldName: 'pcs_sample' };
const pcsKey = `${pcsCtx.wizardId}::${pcsCtx.fieldName}::full::4`;
const pcsRecord = pcsStore.getRecord(pcsKey, 4);
pcsRecord.letterScore = [30, 0, 0, 0];
pcsRecord.numberScore = [0, 30, 30, 30];
pcsRecord.deliberateViolation = true;
pcsStore.records[pcsKey] = pcsRecord;

let pcsStage3 = station3_fingerprintAndScore('5620', pcsCtx, pcsStore);
let pcsStage4 = station4_applyFingerprintFixes('5620', pcsStage3, pcsCtx);
assert.strictEqual(pcsStage4.finalText, 'S620');
assert.strictEqual(pcsStage4.pcsEvaluations[0].okToCorrect, true);

// PCS gating - block word-like tokens
const wordKey = `${pcsCtx.wizardId}::${pcsCtx.fieldName}::full::5`;
const wordRecord = pcsStore.getRecord(wordKey, 5);
wordRecord.letterScore = [30, 0, 0, 0, 0];
wordRecord.numberScore = [0, 30, 30, 30, 0];
wordRecord.deliberateViolation = true;
pcsStore.records[wordKey] = wordRecord;

pcsStage3 = station3_fingerprintAndScore('Storm', pcsCtx, pcsStore);
pcsStage4 = station4_applyFingerprintFixes('Storm', pcsStage3, pcsCtx);
assert.strictEqual(pcsStage4.finalText, 'Storm');
assert.strictEqual(pcsStage4.fingerprintEdits.length, 0);
assert.strictEqual(pcsStage4.pcsEvaluations[0].skipReason, 'PCS_SKIP');

// PCS gating - insufficient evidence
const ambiguousStore = new SegmentModelStore('test-ocrmagic-pcs-ambig', { persist: false });
const ambiguousCtx = { wizardId: 'wiz', fieldName: 'pcs_ambig' };
const ambiguousKey = `${ambiguousCtx.wizardId}::${ambiguousCtx.fieldName}::full::4`;
const ambiguousRecord = ambiguousStore.getRecord(ambiguousKey, 4);
ambiguousRecord.letterScore = [30, 0, 0, 30];
ambiguousRecord.numberScore = [0, 30, 30, 0];
ambiguousRecord.deliberateViolation = true;
ambiguousStore.records[ambiguousKey] = ambiguousRecord;

const ambiguousStage3 = station3_fingerprintAndScore('1O1O', ambiguousCtx, ambiguousStore);
const ambiguousStage4 = station4_applyFingerprintFixes('1O1O', ambiguousStage3, ambiguousCtx);
assert.strictEqual(ambiguousStage4.finalText, '1O1O');
assert.strictEqual(ambiguousStage4.pcsEvaluations[0].okToCorrect, false);

// Segment extraction - address (using explicit segmenter config)
const addrCtx = {
  wizardId: 'wiz',
  fieldName: 'shipping_address',
  segmenterConfig: { segments: [{ id: 'address:first2', strategy: 'first2' }, { id: 'address:last2', strategy: 'last2' }] }
};
const addrStage = station3_fingerprintAndScore('3031 Councillors Way, Ottawa, Ontario, KI7 272', addrCtx, store);
assert.strictEqual(addrStage.segments.length, 2);
assert.strictEqual(addrStage.segments[0].segmentId, 'address:first2');
assert.strictEqual(addrStage.segments[0].rawSegmentText, '3031 Councillors');
assert.strictEqual(addrStage.segments[1].segmentId, 'address:last2');
assert.strictEqual(addrStage.segments[1].rawSegmentText, 'KI7 272');

const addrShort = station3_fingerprintAndScore('K2W 1A3', addrCtx, store);
assert.strictEqual(addrShort.segments.length, 2);
assert.strictEqual(addrShort.segments[0].rawSegmentText, 'K2W 1A3');
assert.strictEqual(addrShort.segments[1].rawSegmentText, 'K2W 1A3');

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

// Chunk gating: numeric chunk should not become letters
const chunkStore = new SegmentModelStore('chunk-guard', { persist: false });
const chunkCtx = { wizardId: 'wiz', fieldName: 'chunky', segmenterConfig: { segments: [{ id: 'full', strategy: 'full' }] } };
const chunkSegKey = `${chunkCtx.wizardId}::${chunkCtx.fieldName}::full::6`;
const chunkRec = chunkStore.getRecord(chunkSegKey, 6);
chunkRec.letterScore = [30, 30, 30, 0, 0, 0];
chunkRec.numberScore = [0, 0, 0, 30, 30, 30];
chunkRec.deliberateViolation = true;
chunkStore.records[chunkSegKey] = chunkRec;
const chunkKey = `${chunkCtx.wizardId}::${chunkCtx.fieldName}::full::chunks::2::3,3`;
chunkStore.updateChunkScores(chunkKey, [{ Lscore: 0, Nscore: 40 }, { Lscore: 40, Nscore: 0 }]);
const numericStage3 = station3_fingerprintAndScore('300 Bay', chunkCtx, chunkStore);
const numericStage4 = station4_applyFingerprintFixes('300 Bay', numericStage3, chunkCtx);
assert.strictEqual(numericStage4.finalText, '300 Bay');

// Chunk gating: ambiguous fix allowed in numeric chunk
const ambStore = new SegmentModelStore('chunk-amb', { persist: false });
const ambCtx = { wizardId: 'wiz', fieldName: 'chunky2', segmenterConfig: { segments: [{ id: 'full', strategy: 'full' }] } };
const ambSegKey = `${ambCtx.wizardId}::${ambCtx.fieldName}::full::3`;
const ambRec = ambStore.getRecord(ambSegKey, 3);
ambRec.numberScore = [40, 40, 40];
ambRec.letterScore = [0, 0, 0];
ambRec.deliberateViolation = true;
ambStore.records[ambSegKey] = ambRec;
const ambChunkKey = `${ambCtx.wizardId}::${ambCtx.fieldName}::full::chunks::1::3`;
ambStore.updateChunkScores(ambChunkKey, [{ Lscore: 0, Nscore: 40 }]);
const ambStage3 = station3_fingerprintAndScore('86I', ambCtx, ambStore);
const ambStage4 = station4_applyFingerprintFixes('86I', ambStage3, ambCtx);
assert.strictEqual(ambStage4.finalText, '861');

// Chunk layout persistence should be per-chunk, not merged across different shapes
const chunkLayoutStore = new SegmentModelStore('chunk-layout', { persist: false });
const chunkLayoutCtx = { wizardId: 'wiz', fieldName: 'chunky3', segmenterConfig: { segments: [{ id: 'full', strategy: 'full' }] } };
for (let i = 0; i < 4; i++) {
  station3_fingerprintAndScore('38 Fortune', chunkLayoutCtx, chunkLayoutStore);
}
let chunkLayoutStage = station3_fingerprintAndScore('38 Fortune', chunkLayoutCtx, chunkLayoutStore);
assert.strictEqual(chunkLayoutStage.segments[0].chunks[0].learnedLayout, 'NN');
assert.strictEqual(chunkLayoutStage.segments[0].chunks[1].learnedLayout, 'LLLLLLL');
assert.strictEqual(chunkLayoutStage.segments[0].learnedLayout, 'NNLLLLLLL');
chunkLayoutStage = station3_fingerprintAndScore('5 Elm', chunkLayoutCtx, chunkLayoutStore);
assert.strictEqual(chunkLayoutStage.segments[0].chunks[0].learnedLayout, '?');
assert.strictEqual(chunkLayoutStage.segments[0].chunks[1].learnedLayout, '???');

console.log('OCRMAGIC pipeline tests passed.');
