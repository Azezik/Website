const assert = require('assert');

const ring = require('../engines/fields/static/ring-landmark.js');
const anchors = require('../engines/geometry/anchors.js');

function legacyEdgeScore(sample, tmpl, half = null){
  const mask = tmpl.ringMask;
  const w = tmpl.patchSize;
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for(let i = 0; i < mask.length; i++){
    if(!mask[i]) continue;
    const x = i % w;
    if(half === 'right' && x < w / 2) continue;
    if(half === 'left' && x >= w / 2) continue;
    sumA += sample.edgePatch[i];
    sumB += tmpl.edgePatch[i];
    count++;
  }
  const meanA = count ? sumA / count : 0;
  const meanB = count ? sumB / count : 0;
  let num = 0;
  let dA = 0;
  let dB = 0;
  let match = 0;
  for(let i = 0; i < mask.length; i++){
    if(!mask[i]) continue;
    const x = i % w;
    if(half === 'right' && x < w / 2) continue;
    if(half === 'left' && x >= w / 2) continue;
    const a = sample.edgePatch[i];
    const b = tmpl.edgePatch[i];
    num += (a - meanA) * (b - meanB);
    dA += (a - meanA) * (a - meanA);
    dB += (b - meanB) * (b - meanB);
    if(a === b) match++;
  }
  if(dA > 0 && dB > 0) return { score: num / Math.sqrt(dA * dB), comparator: 'edge_zncc' };
  return { score: count ? match / count : -1, comparator: 'edge_hamming' };
}

function legacyMatchRingLandmark(lm, guessPx, opts = {}){
  const { captureFn, viewport = {}, half = null } = opts;
  const range = 0.25 * ((viewport.h ?? viewport.height) || 1);
  const step = 4;
  let best = { score: -1, box: null, comparator: null };
  for(let dy = -range; dy <= range; dy += step){
    for(let dx = -range; dx <= range; dx += step){
      const box = { x: guessPx.x + dx, y: guessPx.y + dy, w: guessPx.w, h: guessPx.h, page: guessPx.page };
      const sample = captureFn(box);
      const { score, comparator } = legacyEdgeScore(sample, lm, half);
      if(score > best.score){ best = { score, box, comparator }; }
    }
  }
  const thresh = half ? 0.60 : 0.75;
  if(best.score >= thresh) return { ...best.box, score: best.score, comparator: best.comparator };
  return null;
}

(function run(){
  const tmpl = {
    patchSize: 4,
    ringMask: new Uint8Array([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]),
    edgePatch: new Uint8Array([1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0])
  };
  const sample = {
    edgePatch: new Uint8Array([1,0,1,0,0,0,1,0,1,1,1,0,1,0,1,0])
  };
  assert.deepStrictEqual(ring.edgeScore(sample, tmpl, null), legacyEdgeScore(sample, tmpl, null));
  assert.deepStrictEqual(ring.edgeScore(sample, tmpl, 'right'), legacyEdgeScore(sample, tmpl, 'right'));

  const guess = { x: 50, y: 40, w: 20, h: 10, page: 1 };
  const viewport = { w: 200, h: 200 };
  const hitCapture = (box) => ({ edgePatch: new Uint8Array(16).fill((box.x === 42 && box.y === 48) ? 1 : 0) });
  const hitLegacy = legacyMatchRingLandmark(tmpl, guess, { captureFn: hitCapture, viewport });
  const hitModern = ring.matchRingLandmark(tmpl, guess, { captureFn: hitCapture, viewport });
  assert.deepStrictEqual(hitModern, hitLegacy, 'ring hit decision and resolved box should match');

  const missCapture = () => ({ edgePatch: new Uint8Array(16).fill(0) });
  const missLegacy = legacyMatchRingLandmark(tmpl, guess, { captureFn: missCapture, viewport });
  const missModern = ring.matchRingLandmark(tmpl, guess, { captureFn: missCapture, viewport });
  assert.deepStrictEqual(missModern, missLegacy, 'ring miss decision should match');

  const basePx = { x: 10, y: 20, w: 80, h: 40, page: 2 };
  const matchBox = { x: 15, y: 25, w: 80, h: 40, page: 2 };
  const offset = { dx: 0.25, dy: -0.5 };
  assert.deepStrictEqual(
    ring.applyLandmarkOffset(matchBox, offset, basePx),
    { x: 35, y: 5, w: 80, h: 40, page: 2 },
    'offset application should preserve legacy math'
  );

  const anchorBox = anchors.boxFromAnchor(
    { x: 100, y: 60, page: 1 },
    { dx: 0.2, dy: -0.1, w: 0.3, h: 0.4 },
    { w: 500, h: 200 }
  );
  assert.deepStrictEqual(anchorBox, { x: 200, y: 40, w: 150, h: 80, page: 1 }, 'anchor projection should match legacy math');

  console.log('stage5 ring/anchor helper parity passed');
})();
