const assert = require('assert');

/* ── wizard-mode LEARN integration ───────────────────────────────────────── */

const { enterLearnModeState, WizardMode, createModeController } = require('../tools/wizard-mode.js');

function buildState(){
  return {
    mode: 'CONFIG',
    stepIdx: 5,
    steps: ['a','b'],
    selectionCss: { x:1 },
    selectionPx: { x:2 },
    snappedCss: { x:3 },
    snappedPx: { x:4 },
    snappedText: 'old',
    pendingSelection: { active:true },
    matchPoints: [1,2],
    overlayMetrics: { foo:'bar' },
    overlayPinned: true,
    pdf: { doc:'sample' },
    isImage: true,
    pageNum: 3,
    numPages: 6,
    viewport: { w: 100, h: 200, scale: 2 },
    pageOffsets: [1],
    pageViewports: [2],
    pageRenderPromises: [],
    pageRenderReady: [],
    pageSnapshots: { a:1 },
    grayCanvases: { 1: {} },
    telemetry: [{ stage: 'seen' }],
    currentTraceId: 'trace-1',
    lastOcrCropPx: { w:1 },
    lastOcrCropCss: { h:2 },
    cropAudits: [1,2],
    cropHashes: { h:1 },
    tokensByPage: { 1:[{text:'a'}] },
    currentLineItems: [{ id:1 }],
    currentFileId: 'file',
    currentFileName: 'name.pdf',
    lineLayout: { rows: 3 },
    profile: { keep: 'me' }
  };
}

// enterLearnModeState clears transient state and sets LEARN
const learnState = enterLearnModeState(buildState());
assert.strictEqual(learnState.mode, WizardMode.LEARN);
assert.strictEqual(learnState.stepIdx, 0);
assert.deepStrictEqual(learnState.steps, []);
assert.strictEqual(learnState.pendingSelection, null);
assert.deepStrictEqual(learnState.learningAnnotations, []);
assert.deepStrictEqual(learnState.profile, { keep: 'me' });

// createModeController supports LEARN
const controller = createModeController({ warn:()=>{} });
controller.setMode(WizardMode.LEARN);
assert.strictEqual(controller.getMode(), WizardMode.LEARN);
assert.strictEqual(controller.isLearn(), true);
assert.strictEqual(controller.isRun(), false);
assert.strictEqual(controller.guardInteractive('test'), false, 'LEARN allows interactive');

console.log('wizard-mode LEARN tests passed.');

/* ── learning-store ──────────────────────────────────────────────────────── */

const {
  ANNOTATION_CATEGORIES,
  createAnnotationBox,
  createAnnotationRecord,
  snapshotRegion,
  normalizeBox,
  createLearningStore,
  createMemoryBackend
} = require('../engines/wrokitvision/learning/learning-store.js');

// ANNOTATION_CATEGORIES
assert.ok(ANNOTATION_CATEGORIES.includes('visual_region'));
assert.ok(ANNOTATION_CATEGORIES.includes('text_group'));
assert.ok(ANNOTATION_CATEGORIES.includes('label'));
assert.ok(ANNOTATION_CATEGORIES.includes('shape'));
assert.ok(ANNOTATION_CATEGORIES.includes('field_value'));
assert.ok(ANNOTATION_CATEGORIES.includes('structural_section'));
assert.ok(Object.isFrozen(ANNOTATION_CATEGORIES));

// normalizeBox
const nb = normalizeBox({ x: 100, y: 200, w: 300, h: 400 }, { w: 1000, h: 1000 });
assert.strictEqual(nb.x0n, 0.1);
assert.strictEqual(nb.y0n, 0.2);
assert.strictEqual(nb.wN, 0.3);
assert.strictEqual(nb.hN, 0.4);

// createAnnotationBox
const box = createAnnotationBox({
  label: 'logo area',
  category: 'shape',
  rawBox: { x: 10, y: 20, w: 100, h: 50 },
  viewport: { w: 500, h: 800 },
  tokenIds: ['t1', 't2'],
  text: 'ACME',
  notes: 'company logo'
});
assert.ok(box.boxId.startsWith('abox-'));
assert.strictEqual(box.label, 'logo area');
assert.strictEqual(box.category, 'shape');
assert.strictEqual(box.confidence, 1.0);
assert.strictEqual(box.rawBox.x, 10);
assert.strictEqual(box.normBox.x0n, 10 / 500);
assert.deepStrictEqual(box.tokens, ['t1', 't2']);

// invalid category falls back to 'other'
const box2 = createAnnotationBox({ category: 'nonsense' });
assert.strictEqual(box2.category, 'other');

// snapshotRegion
const region = {
  id: 'sr-001',
  geometry: { bbox: { x: 50, y: 100, w: 200, h: 150 } },
  confidence: 0.72,
  textDensity: 0.45,
  surfaceTypeCandidate: 'region_surface'
};
const snap = snapshotRegion(region, { w: 800, h: 1000 });
assert.strictEqual(snap.regionId, 'sr-001');
assert.strictEqual(snap.bbox.x, 50);
assert.strictEqual(snap.normBox.x0n, 50 / 800);
assert.strictEqual(snap.confidence, 0.72);
assert.strictEqual(snap.surfaceType, 'region_surface');

// createAnnotationRecord
const rec = createAnnotationRecord({
  imageId: 'img-001',
  imageName: 'test.png',
  viewport: { w: 800, h: 1000 },
  annotations: [box],
  autoRegions: [snap]
});
assert.ok(rec.recordId.startsWith('lrec-'));
assert.strictEqual(rec.imageId, 'img-001');
assert.strictEqual(rec.annotations.length, 1);
assert.strictEqual(rec.autoRegions.length, 1);
assert.ok(rec.timestamp);

// LearningStore CRUD
const store = createLearningStore(createMemoryBackend());
assert.strictEqual(store.count(), 0);
store.addRecord(rec);
assert.strictEqual(store.count(), 1);
assert.strictEqual(store.totalAnnotations(), 1);

const retrieved = store.getRecord(rec.recordId);
assert.strictEqual(retrieved.imageId, 'img-001');

const byImage = store.getRecordsByImage('img-001');
assert.strictEqual(byImage.length, 1);

const stats = store.stats();
assert.strictEqual(stats.totalRecords, 1);
assert.strictEqual(stats.totalBoxes, 1);
assert.strictEqual(stats.categories.shape, 1);

// Export / import
const json = store.exportJSON();
const store2 = createLearningStore(createMemoryBackend());
const imported = store2.importJSON(json);
assert.strictEqual(imported, 1);
assert.strictEqual(store2.count(), 1);

// Import deduplicates by recordId
const imported2 = store2.importJSON(json);
assert.strictEqual(imported2, 0);
assert.strictEqual(store2.count(), 1);

// Delete
store.deleteRecord(rec.recordId);
assert.strictEqual(store.count(), 0);

// Clear
store.addRecord(rec);
store.clear();
assert.strictEqual(store.count(), 0);

console.log('learning-store tests passed.');

/* ── learning-session ────────────────────────────────────────────────────── */

const {
  LEARNING_PROMPTS,
  computeIoU,
  compareAnnotationsToRegions,
  createLearningSession
} = require('../engines/wrokitvision/learning/learning-session.js');

// LEARNING_PROMPTS
assert.ok(LEARNING_PROMPTS.length >= 4);
assert.strictEqual(LEARNING_PROMPTS[0].id, 'visual_regions');
assert.strictEqual(LEARNING_PROMPTS[0].multiBox, true);

// computeIoU - identical boxes
assert.strictEqual(computeIoU(
  { x0n: 0.1, y0n: 0.1, wN: 0.5, hN: 0.5 },
  { x0n: 0.1, y0n: 0.1, wN: 0.5, hN: 0.5 }
), 1);

// computeIoU - no overlap
assert.strictEqual(computeIoU(
  { x0n: 0, y0n: 0, wN: 0.1, hN: 0.1 },
  { x0n: 0.5, y0n: 0.5, wN: 0.1, hN: 0.1 }
), 0);

// computeIoU - partial overlap
const iou = computeIoU(
  { x0n: 0, y0n: 0, wN: 0.4, hN: 0.4 },
  { x0n: 0.2, y0n: 0.2, wN: 0.4, hN: 0.4 }
);
assert.ok(iou > 0.1 && iou < 0.5, `Expected partial IoU, got ${iou}`);

// compareAnnotationsToRegions
const humanAnns = [
  { category: 'visual_region', normBox: { x0n: 0, y0n: 0, wN: 0.5, hN: 0.5 } },
  { category: 'visual_region', normBox: { x0n: 0.6, y0n: 0.6, wN: 0.3, hN: 0.3 } }
];
const autoRegs = [
  { normBox: { x0n: 0.02, y0n: 0.02, wN: 0.48, hN: 0.48 } },  // matches first human
  { normBox: { x0n: 0.3, y0n: 0.3, wN: 0.1, hN: 0.1 } }        // no match
];
const comp = compareAnnotationsToRegions(humanAnns, autoRegs);
assert.strictEqual(comp.stats.humanRegionCount, 2);
assert.strictEqual(comp.stats.autoRegionCount, 2);
assert.strictEqual(comp.stats.matchCount, 1);
assert.strictEqual(comp.stats.missedCount, 1);
assert.strictEqual(comp.stats.extraCount, 1);

// createLearningSession
const session = createLearningSession({
  viewport: { w: 800, h: 1000 },
  tokens: [{ id: 't1', text: 'hello' }],
  analysisResult: { regionNodes: [region] }
});

assert.ok(session.getPrompts().length >= 4);
assert.strictEqual(session.annotationCount(), 0);
assert.strictEqual(session.isFinalized(), false);

// Add annotations
session.addAnnotation({
  label: 'header panel',
  category: 'visual_region',
  rawBox: { x: 0, y: 0, w: 800, h: 100 }
});
assert.strictEqual(session.annotationCount(), 1);

session.addAnnotation({
  label: 'invoice number',
  category: 'field_value',
  rawBox: { x: 400, y: 200, w: 200, h: 30 },
  text: 'INV-001'
});
assert.strictEqual(session.annotationCount(), 2);

// Undo
const undone = session.undoLast();
assert.strictEqual(undone.label, 'invoice number');
assert.strictEqual(session.annotationCount(), 1);

// Re-add for finalization
session.addAnnotation({
  label: 'total amount',
  category: 'field_value',
  rawBox: { x: 400, y: 800, w: 200, h: 30 },
  text: '$47.82'
});

// Get by category
assert.strictEqual(session.getAnnotationsByCategory('visual_region').length, 1);
assert.strictEqual(session.getAnnotationsByCategory('field_value').length, 1);

// Auto regions snapshot
assert.strictEqual(session.getAutoRegions().length, 1);

// Finalize
const finalRecord = session.finalize({ imageId: 'test-img', imageName: 'test.png' });
assert.ok(finalRecord.recordId.startsWith('lrec-'));
assert.strictEqual(finalRecord.annotations.length, 2);
assert.strictEqual(finalRecord.autoRegions.length, 1);
assert.ok(finalRecord.metadata.comparison);
assert.strictEqual(finalRecord.metadata.tokenCount, 1);
assert.strictEqual(session.isFinalized(), true);

// Cannot add after finalize
assert.throws(() => session.addAnnotation({ category: 'label' }), /already finalized/);
assert.throws(() => session.finalize({}), /already finalized/);

console.log('learning-session tests passed.');

/* ── learning-analyst ────────────────────────────────────────────────────── */

const {
  analyzeRegionDetection,
  analyzeSurfaceClassification,
  analyzeRankingWeights,
  analyzeConfidenceThresholds,
  analyzeAll
} = require('../engines/wrokitvision/learning/learning-analyst.js');

// Build a set of mock records for analysis
function buildMockRecords(count){
  const records = [];
  for(let i = 0; i < count; i++){
    records.push({
      recordId: `rec-${i}`,
      imageId: `img-${i}`,
      viewport: { w: 800, h: 1000 },
      annotations: [
        { category: 'visual_region', normBox: { x0n: 0.05, y0n: 0.02, wN: 0.9, hN: 0.15 } },
        { category: 'visual_region', normBox: { x0n: 0.05, y0n: 0.20, wN: 0.9, hN: 0.60 } },
        { category: 'text_group', normBox: { x0n: 0.1, y0n: 0.25, wN: 0.4, hN: 0.10 } },
        { category: 'label', normBox: { x0n: 0.1, y0n: 0.25, wN: 0.15, hN: 0.03 } },
        { category: 'field_value', normBox: { x0n: 0.3, y0n: 0.25, wN: 0.2, hN: 0.03 } },
        { category: 'shape', normBox: { x0n: 0.7, y0n: 0.03, wN: 0.1, hN: 0.08 } }
      ],
      autoRegions: [
        { regionId: `ar-${i}-0`, normBox: { x0n: 0.04, y0n: 0.01, wN: 0.92, hN: 0.16 }, confidence: 0.65, textDensity: 0.55, surfaceType: 'text_dense_surface' },
        { regionId: `ar-${i}-1`, normBox: { x0n: 0.04, y0n: 0.19, wN: 0.92, hN: 0.62 }, confidence: 0.70, textDensity: 0.60, surfaceType: 'text_dense_surface' },
        { regionId: `ar-${i}-2`, normBox: { x0n: 0.3, y0n: 0.5, wN: 0.1, hN: 0.05 }, confidence: 0.40, textDensity: 0.10, surfaceType: 'region_surface' },
        { regionId: `ar-${i}-3`, normBox: { x0n: 0.8, y0n: 0.8, wN: 0.05, hN: 0.05 }, confidence: 0.30, textDensity: 0.05, surfaceType: 'region_surface' }
      ]
    });
  }
  return records;
}

// analyzeAll with no data
const emptyReport = analyzeAll([]);
assert.strictEqual(emptyReport.status, 'insufficient_data');
assert.strictEqual(emptyReport.recommendations, null);

// analyzeAll with few records
const fewRecords = buildMockRecords(3);
const earlyReport = analyzeAll(fewRecords);
assert.strictEqual(earlyReport.status, 'early');
assert.ok(earlyReport.recommendations);
assert.ok(earlyReport.recommendations.regionDetection);
assert.ok(earlyReport.recommendations.surfaceClassification);
assert.ok(earlyReport.recommendations.rankingWeights);
assert.ok(earlyReport.recommendations.confidenceThresholds);

// analyzeAll with enough records
const manyRecords = buildMockRecords(20);
const fullReport = analyzeAll(manyRecords);
assert.strictEqual(fullReport.status, 'ready');
assert.strictEqual(fullReport.recordCount, 20);
assert.ok(fullReport.totalAnnotations > 0);

// Region detection analysis
const rd = fullReport.recommendations.regionDetection;
assert.ok(['over', 'under', 'balanced'].includes(rd.segmentationBias));
assert.ok(typeof rd.suggestedMergeThreshold === 'number');
assert.ok(rd.suggestedMergeThreshold >= 16 && rd.suggestedMergeThreshold <= 64);
assert.ok(typeof rd.suggestedMinRegionArea === 'number');
assert.ok(rd.evidence.recordCount === 20);

// Surface classification analysis
const sc = fullReport.recommendations.surfaceClassification;
assert.ok(typeof sc.suggestedTextDenseThreshold === 'number');
assert.ok(sc.suggestedTextDenseThreshold >= 0.3 && sc.suggestedTextDenseThreshold <= 0.7);

// Ranking weights analysis
const rw = fullReport.recommendations.rankingWeights;
assert.ok(rw.suggestedWeights);
assert.ok(typeof rw.suggestedWeights.anchorTextSimilarity === 'number');
// Weights should roughly sum to 1
const weightSum = Object.values(rw.suggestedWeights).reduce((s, v) => s + v, 0);
assert.ok(Math.abs(weightSum - 1.0) < 0.05, `Weight sum ${weightSum} should be ~1.0`);

// Confidence threshold analysis
const ct = fullReport.recommendations.confidenceThresholds;
assert.ok(typeof ct.suggestedMinConfidence === 'number');
assert.ok(ct.suggestedMinConfidence >= 0.3 && ct.suggestedMinConfidence <= 0.8);

console.log('learning-analyst tests passed.');

/* ── learning/index.js public API ────────────────────────────────────────── */

const { LearningStore: LS, LearningSession: LSess, LearningAnalyst: LA } = require('../engines/wrokitvision/learning/index.js');
assert.ok(LS.createLearningStore);
assert.ok(LSess.createLearningSession);
assert.ok(LA.analyzeAll);

console.log('learning/index.js API tests passed.');
console.log('All Wrokit Vision Learning tests passed.');
