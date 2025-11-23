const assert = require('assert');
const { enterRunModeState, enterConfigModeState, clearTransientState } = require('../tools/wizard-mode.js');

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
    pageOffsets: [1],
    pageViewports: [2],
    pageRenderPromises: [Promise.resolve()],
    pageRenderReady: [true],
    pageSnapshots: { a:1 },
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

const cleared = clearTransientState(buildState());
assert.strictEqual(cleared.mode, 'CONFIG');
assert.strictEqual(cleared.stepIdx, 0);
assert.strictEqual(cleared.snappedCss, null);
assert.deepStrictEqual(cleared.pageOffsets, []);

console.log('Wizard mode tests passed.');
