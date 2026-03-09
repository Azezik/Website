'use strict';

const assert = require('node:assert/strict');
const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

function luminance(r, g, b){
  return Math.round((0.299 * r) + (0.587 * g) + (0.114 * b));
}

(function run(){
  const viewport = { width: 220, height: 120 };
  const total = viewport.width * viewport.height;
  const r = new Uint8Array(total).fill(186);
  const g = new Uint8Array(total).fill(186);
  const b = new Uint8Array(total).fill(186);

  for(let y = 20; y < 95; y++){
    for(let x = 18; x < 95; x++){
      const idx = (y * viewport.width) + x;
      r[idx] = 210;
      g[idx] = 160;
      b[idx] = 160;
    }
    for(let x = 122; x < 202; x++){
      const idx = (y * viewport.width) + x;
      r[idx] = 150;
      g[idx] = 208;
      b[idx] = 150;
    }
  }

  const gray = new Uint8Array(total);
  for(let i = 0; i < total; i++) gray[i] = luminance(r[i], g[i], b[i]);

  const seed = WrokitVisionEngine.createSeedArtifacts({
    tokens: [],
    viewport,
    imageData: { gray, r, g, b, width: viewport.width, height: viewport.height },
    page: 1,
    geometryId: 'geom_color_barrier'
  });

  const visualRegions = seed.precomputedStructuralMap.uploadedImageAnalysis.regionNodes
    .filter(region => region?.provenance?.detector === 'connected-components-threshold');

  assert.ok(visualRegions.length >= 2, 'color-seeded proposals should recover multiple low-luminance regions');
  assert.ok(visualRegions.every(region => region?.features?.colorAwareBarrier === true), 'color-aware barrier flag should be set when rgb channels are present');

  const merged = visualRegions.find(region => {
    const box = region?.geometry?.bbox || {};
    return box.w > 160 && box.h > 60;
  });
  assert.equal(Boolean(merged), false, 'two color-distinct blocks should not collapse into a single wide region');

  console.log('wrokitvision color-aware region proposals test passed');
})();
