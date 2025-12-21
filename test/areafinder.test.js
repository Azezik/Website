const assert = require('assert');
const { findAreaOccurrencesForPage } = require('../tools/areafinder.js');
const { normalizeKeywordText } = require('../tools/keyword-weighting.js');

function makeOrientation(areaBox, tokenBox, pageW, pageH, role){
  const normText = normalizeKeywordText('corner ' + role.toLowerCase());
  const bboxNorm = {
    x: tokenBox.x / pageW,
    y: tokenBox.y / pageH,
    w: tokenBox.w / pageW,
    h: tokenBox.h / pageH
  };
  return {
    role,
    normText,
    bboxNorm,
    centerRel: {
      cx: (tokenBox.x + tokenBox.w / 2 - areaBox.x) / areaBox.w,
      cy: (tokenBox.y + tokenBox.h / 2 - areaBox.y) / areaBox.h
    },
    edgeOffsets: {
      left: (tokenBox.x - areaBox.x) / areaBox.w,
      right: (areaBox.x + areaBox.w - (tokenBox.x + tokenBox.w)) / areaBox.w,
      top: (tokenBox.y - areaBox.y) / areaBox.h,
      bottom: (areaBox.y + areaBox.h - (tokenBox.y + tokenBox.h)) / areaBox.h
    }
  };
}

function buildAreaFingerprint(areaBox, pageW, pageH){
  const topRightToken = { x: areaBox.x + areaBox.w * 0.7, y: areaBox.y + areaBox.h * 0.05, w: areaBox.w * 0.25, h: areaBox.h * 0.15 };
  const bottomLeftToken = { x: areaBox.x + areaBox.w * 0.05, y: areaBox.y + areaBox.h * 0.75, w: areaBox.w * 0.2, h: areaBox.h * 0.2 };
  return {
    page: 1,
    bboxPct: {
      x0: areaBox.x / pageW,
      y0: areaBox.y / pageH,
      x1: (areaBox.x + areaBox.w) / pageW,
      y1: (areaBox.y + areaBox.h) / pageH
    },
    orientation: {
      topRight: makeOrientation(areaBox, topRightToken, pageW, pageH, 'topRight'),
      bottomLeft: makeOrientation(areaBox, bottomLeftToken, pageW, pageH, 'bottomLeft')
    }
  };
}

function emitTokens(areaBox, pageW, pageH){
  const fp = buildAreaFingerprint(areaBox, pageW, pageH);
  const tokens = [];
  const addToken = (orient) => {
    tokens.push({
      text: orient.normText,
      x: orient.bboxNorm.x * pageW,
      y: orient.bboxNorm.y * pageH,
      w: orient.bboxNorm.w * pageW,
      h: orient.bboxNorm.h * pageH,
      page: 1
    });
  };
  addToken(fp.orientation.topRight);
  addToken(fp.orientation.bottomLeft);
  return { tokens, fp };
}

function nearlyEqual(a, b, tol = 6){
  return Math.abs(a - b) <= tol;
}

function assertBoxNear(actual, expected){
  assert.ok(nearlyEqual(actual.x, expected.x), `x mismatch ${actual.x} vs ${expected.x}`);
  assert.ok(nearlyEqual(actual.y, expected.y), `y mismatch ${actual.y} vs ${expected.y}`);
  assert.ok(nearlyEqual(actual.w, expected.w), `w mismatch ${actual.w} vs ${expected.w}`);
  assert.ok(nearlyEqual(actual.h, expected.h), `h mismatch ${actual.h} vs ${expected.h}`);
}

async function main(){
  const pageW = 400;
  const pageH = 400;

  const firstArea = { x: 40, y: 60, w: 140, h: 90 };
  const secondArea = { x: 220, y: 220, w: 140, h: 90 };

  const { tokens: tokensA, fp } = emitTokens(firstArea, pageW, pageH);
  const { tokens: tokensB } = emitTokens(secondArea, pageW, pageH);
  const tokens = tokensA.concat(tokensB);

  const occurrences = findAreaOccurrencesForPage([
    { fieldKey: 'area_section', areaId: 'section', areaFingerprint: fp }
  ], tokens, { pageW, pageH });

  assert.strictEqual(occurrences.length, 2, 'should detect both area occurrences');
  assertBoxNear(occurrences[0].bboxPx, firstArea);
  assertBoxNear(occurrences[1].bboxPx, secondArea);
  assert.ok(occurrences.every(o => o.confidence > 0.4), 'confidence should reflect geometry');

  const emptyResult = findAreaOccurrencesForPage([], tokens, { pageW, pageH });
  assert.strictEqual(emptyResult.length, 0, 'no area configs should return no matches');

  console.log('AreaFinder tests passed.');
}

main();
