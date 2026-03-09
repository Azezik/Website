'use strict';

const assert = require('node:assert/strict');
const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

function orientation(a, b, c){
  const v = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if(Math.abs(v) < 1e-6) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(a, b, c){
  return b.x <= Math.max(a.x, c.x) && b.x >= Math.min(a.x, c.x) && b.y <= Math.max(a.y, c.y) && b.y >= Math.min(a.y, c.y);
}

function segmentsIntersect(p1, q1, p2, q2){
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if(o1 !== o2 && o3 !== o4) return true;
  if(o1 === 0 && onSegment(p1, p2, q1)) return true;
  if(o2 === 0 && onSegment(p1, q2, q1)) return true;
  if(o3 === 0 && onSegment(p2, p1, q2)) return true;
  if(o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function hasSelfIntersection(points = []){
  if(points.length < 4) return false;
  for(let i = 0; i < points.length; i++){
    const a1 = points[i];
    const a2 = points[(i + 1) % points.length];
    for(let j = i + 1; j < points.length; j++){
      if(Math.abs(i - j) <= 1) continue;
      if(i === 0 && j === points.length - 1) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % points.length];
      if(segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

(function run(){
  const viewport = { width: 240, height: 160 };
  const gray = new Uint8Array(viewport.width * viewport.height).fill(255);

  for(let y = 40; y < 120; y++){
    for(let x = 30; x < 200; x++) gray[(y * viewport.width) + x] = 32;
  }

  const seed = WrokitVisionEngine.createSeedArtifacts({
    tokens: [],
    viewport,
    imageData: { gray, width: viewport.width, height: viewport.height },
    page: 1,
    geometryId: 'geom_contour_ordering'
  });

  const visualRegions = seed.precomputedStructuralMap.uploadedImageAnalysis.regionNodes
    .filter(region => region?.provenance?.detector === 'atomic-region-merge');

  assert.ok(visualRegions.length > 0, 'expected at least one visual region proposal');

  const contour = visualRegions[0]?.geometry?.contour || [];
  assert.ok(contour.length >= 8, 'visual contour should keep enough ordered points');
  assert.equal(hasSelfIntersection(contour), false, 'visual contour should not self-intersect');

  console.log('wrokitvision region contour ordering test passed');
})();
