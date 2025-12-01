const assert = require('assert');
const { assembleTextFromBox } = require('../tools/static-field-mode.js');
const StaticResolverRollout = require('../tools/static-resolver-rollout.js');

function simpleResolve({ tokens, baseBox, keywordShift=null, triBox=null, featureEnabled=true, ftype='static' }){
  const useResolver = ftype === 'static' ? featureEnabled : true;
  const runBBox = (box, stage) => {
    const assembled = assembleTextFromBox({ tokens, box, minOverlap: 0.5 });
    const text = (assembled.text || '').trim();
    if(text){
      return { value: text, stage, locked: stage !== 'triangulation', box };
    }
    return null;
  };
  const legacy = () => runBBox(baseBox, 'legacy-bbox') || { value: '', stage: 'legacy-bbox', locked: false, box: baseBox };
  const staged = () => {
    const bbox = runBBox(baseBox, 'bbox');
    if(bbox){ return bbox; }
    if(keywordShift){
      const shifted = { ...baseBox, x: baseBox.x + keywordShift.dx, y: baseBox.y + keywordShift.dy };
      const kd = runBBox(shifted, 'keyword-delta');
      if(kd){ return kd; }
    }
    if(triBox){
      const tri = runBBox(triBox, 'triangulation');
      if(tri){ return tri; }
      return { value: '', stage: 'triangulation', locked: false, box: triBox };
    }
    return { value: '', stage: null, locked: false, box: baseBox };
  };
  return useResolver ? staged() : legacy();
}

function runSnapshots(featureEnabled=true){
  const baseBox = { x: 0, y: 0, w: 50, h: 12, page: 1 };
  const alignedTokens = [ { text: 'ALIGNED-VALUE', x: 5, y: 2, w: 30, h: 6, page: 1 } ];
  const shiftedTokens = [ { text: 'SHIFTED-VALUE', x: 80, y: 4, w: 30, h: 6, page: 1 } ];
  const heavyTokens = [ { text: 'TRIANGULATED', x: 155, y: 20, w: 32, h: 6, page: 1 } ];
  const mismatchTokens = [ { text: 'OFF-TEMPLATE', x: 260, y: 32, w: 28, h: 6, page: 1 } ];

  return {
    aligned: simpleResolve({ tokens: alignedTokens, baseBox, featureEnabled }),
    shifted: simpleResolve({ tokens: shiftedTokens, baseBox, keywordShift: { dx: 60, dy: 0 }, featureEnabled }),
    heavilyShifted: simpleResolve({ tokens: heavyTokens, baseBox, keywordShift: { dx: 30, dy: 0 }, triBox: { x: 140, y: 18, w: 48, h: 10, page: 1 }, featureEnabled }),
    mismatched: simpleResolve({ tokens: mismatchTokens, baseBox, keywordShift: { dx: 40, dy: 0 }, triBox: { x: 140, y: 18, w: 48, h: 10, page: 1 }, featureEnabled })
  };
}

const enabledSnapshots = runSnapshots(true);
assert.strictEqual(enabledSnapshots.aligned.stage, 'bbox');
assert.strictEqual(enabledSnapshots.aligned.locked, true);
assert.strictEqual(enabledSnapshots.aligned.value, 'ALIGNED-VALUE');

assert.strictEqual(enabledSnapshots.shifted.stage, 'keyword-delta');
assert.strictEqual(enabledSnapshots.shifted.locked, true);
assert.strictEqual(enabledSnapshots.shifted.value, 'SHIFTED-VALUE');

assert.strictEqual(enabledSnapshots.heavilyShifted.stage, 'triangulation');
assert.strictEqual(enabledSnapshots.heavilyShifted.locked, false);
assert.strictEqual(enabledSnapshots.heavilyShifted.value, 'TRIANGULATED');

assert.strictEqual(enabledSnapshots.mismatched.stage, 'triangulation');
assert.strictEqual(enabledSnapshots.mismatched.locked, false);
assert.strictEqual(enabledSnapshots.mismatched.value, '');

const disabledSnapshots = runSnapshots(false);
assert.strictEqual(disabledSnapshots.shifted.stage, 'legacy-bbox');
assert.strictEqual(disabledSnapshots.shifted.locked, false);
assert.strictEqual(disabledSnapshots.shifted.value, '');

const dynamicResolver = simpleResolve({
  tokens: [ { text: 'DYNAMIC', x: 6, y: 2, w: 24, h: 6, page: 1 } ],
  baseBox: { x: 0, y: 0, w: 40, h: 10, page: 1 },
  featureEnabled: false,
  ftype: 'dynamic'
});
assert.strictEqual(dynamicResolver.stage, 'bbox');
assert.strictEqual(dynamicResolver.locked, true);
assert.strictEqual(dynamicResolver.value, 'DYNAMIC');

const rolloutEnabled = StaticResolverRollout.isEnabled({ windowOverride: { FEATURE_STATIC_RESOLVER_ALL: true } });
const rolloutDisabled = StaticResolverRollout.isEnabled({ windowOverride: { FEATURE_STATIC_RESOLVER_ALL: false } });
assert.strictEqual(rolloutEnabled, true);
assert.strictEqual(rolloutDisabled, false);

console.log('Static resolver snapshot tests passed.');
