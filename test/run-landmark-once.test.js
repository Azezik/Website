const assert = require('assert');
const { matchRingLandmarkOnce, maybeBoostWithLandmark } = require('../tools/run-landmark-once.js');

async function main(){
  let captureCalls = 0;
  const fieldConfig = { landmark: { template: true }, bbox: [0,0,1,1], page: 0 };
  const sampleBox = { x: 10, y: 10, w: 20, h: 20, page: 1 };
  const captureFn = (box) => { captureCalls += 1; return { box }; };
  const compareFn = () => ({ score: 0.7 });
  const resolveBox = () => sampleBox;

  const boost = maybeBoostWithLandmark({
    fieldConfig,
    pageTokens: [{ page: 1 }],
    baseConfidence: 0.5,
    baseBoxPx: sampleBox,
    captureFn,
    compareFn,
    resolveBox
  });

  assert.strictEqual(boost.confidence, 0.7, 'landmark should be able to raise confidence');
  assert.strictEqual(captureCalls, 1, 'captureRingLandmark should run once per field');

  captureCalls = 0;
  const highConfidence = maybeBoostWithLandmark({
    fieldConfig,
    pageTokens: [{ page: 1 }],
    baseConfidence: 0.95,
    baseBoxPx: sampleBox,
    captureFn: () => { captureCalls += 1; return { box: sampleBox }; },
    compareFn: () => ({ score: 0.1 }),
    resolveBox
  });

  assert.strictEqual(highConfidence.confidence, 0.95, 'strong base confidence should not be reduced');
  assert.strictEqual(captureCalls, 0, 'high confidence skips landmark capture');

  const nullScore = matchRingLandmarkOnce(fieldConfig, [], { captureFn: () => null, compareFn, resolveBox });
  assert.strictEqual(nullScore, null, 'failed capture should return null');

  console.log('Run-mode landmark throttling tests passed.');
}

main();
