const assert = require('assert');
const { enterRunModeState, enterConfigModeState, clearTransientState, createRunLoopGuard, createRunDiagnostics, runKeyForFile } = require('../tools/wizard-mode.js');

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
    pageRenderPromises: [Promise.resolve()],
    pageRenderReady: [true],
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

const runState = enterRunModeState(buildState());
assert.strictEqual(runState.mode, 'RUN');
assert.strictEqual(runState.stepIdx, 0);
assert.deepStrictEqual(runState.steps, []);
assert.strictEqual(runState.selectionPx, null);
assert.strictEqual(runState.snappedText, '');
assert.strictEqual(runState.pdf, null);
assert.strictEqual(runState.isImage, false);
assert.strictEqual(runState.pageNum, 1);
assert.strictEqual(runState.numPages, 0);
assert.deepStrictEqual(runState.viewport, { w:0, h:0, scale:1 });
assert.deepStrictEqual(runState.grayCanvases, {});
assert.deepStrictEqual(runState.telemetry, []);
assert.strictEqual(runState.currentTraceId, null);
assert.strictEqual(runState.lastOcrCropPx, null);
assert.strictEqual(runState.lastOcrCropCss, null);
assert.deepStrictEqual(runState.cropAudits, []);
assert.deepStrictEqual(runState.cropHashes, {});
assert.deepStrictEqual(runState.tokensByPage, {});
assert.strictEqual(runState.currentFileId, '');
assert.strictEqual(runState.overlayPinned, false);
assert.deepStrictEqual(runState.profile, { keep: 'me' });

const cfgState = enterConfigModeState(buildState());
assert.strictEqual(cfgState.mode, 'CONFIG');
assert.strictEqual(cfgState.stepIdx, 0);
assert.deepStrictEqual(cfgState.steps, []);
assert.strictEqual(cfgState.pendingSelection, null);
assert.strictEqual(cfgState.currentFileName, '');
assert.strictEqual(cfgState.pdf, null);
assert.strictEqual(cfgState.isImage, false);
assert.strictEqual(cfgState.pageNum, 1);
assert.strictEqual(cfgState.numPages, 0);
assert.deepStrictEqual(cfgState.viewport, { w:0, h:0, scale:1 });

const cleared = clearTransientState(buildState());
assert.strictEqual(cleared.mode, 'CONFIG');
assert.strictEqual(cleared.stepIdx, 0);
assert.strictEqual(cleared.snappedCss, null);
assert.deepStrictEqual(cleared.pageOffsets, []);

const guard = createRunLoopGuard();
const keyA = 'fileA';
const keyB = 'fileB';
assert.strictEqual(guard.start(keyA), true, 'first start should pass');
assert.strictEqual(guard.start(keyA), false, 'duplicate start should be blocked');
assert.strictEqual(guard.start(keyB), true, 'different key can start while first is active');
guard.finish(keyA);
assert.strictEqual(guard.start(keyA), true, 'keyA can start after finish');
guard.finish(keyA);
guard.finish(keyB);

const fakeFile = { name:'demo.pdf', size: 1234, lastModified: 1700000000000 };
assert.strictEqual(runKeyForFile(fakeFile), 'demo.pdf::1234::1700000000000');

const diag = createRunDiagnostics();
diag.startExtraction(keyA);
diag.startExtraction(keyA);
diag.finishExtraction(keyA);
diag.noteModeSync('pendingSelection');
diag.noteModeSync('pendingSelection');
assert.strictEqual(diag.stats().extractionStarts[keyA], 2);
assert.strictEqual(diag.stats().extractionFinishes[keyA], 1);
assert.strictEqual(diag.shouldThrottleModeSync('pendingSelection', 2), true);
diag.reset();
assert.deepStrictEqual(diag.stats(), { extractionStarts:{}, extractionFinishes:{}, modeSyncCounts:{} });

const guard2 = createRunLoopGuard();
const diag2 = createRunDiagnostics();
if(guard2.start(keyA)) diag2.startExtraction(keyA);
if(guard2.start(keyA)) diag2.startExtraction(keyA);
guard2.finish(keyA);
assert.strictEqual(diag2.stats().extractionStarts[keyA], 1);

console.log('Wizard mode tests passed.');
