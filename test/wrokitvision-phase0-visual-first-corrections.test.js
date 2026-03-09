'use strict';

const assert = require('node:assert/strict');
const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

(function run(){
  const viewport = { width: 240, height: 160 };
  const tokens = [
    { text: 'Invoice', x: 18, y: 20, w: 50, h: 10 },
    { text: 'No', x: 72, y: 20, w: 16, h: 10 },
    { text: 'A-12345', x: 96, y: 20, w: 58, h: 10 }
  ];
  const gray = new Uint8Array((viewport.width * viewport.height)).fill(255);
  for(let y = 50; y < 110; y++){
    for(let x = 30; x < 210; x++) gray[(y * viewport.width) + x] = 24;
  }

  const seed = WrokitVisionEngine.createSeedArtifacts({
    tokens,
    viewport,
    imageData: { gray, width: viewport.width, height: viewport.height },
    page: 1,
    geometryId: 'geom_phase0'
  });

  const analysis = seed.precomputedStructuralMap?.uploadedImageAnalysis;
  assert.ok(analysis, 'precompute analysis should exist');
  assert.ok(analysis.debugArtifacts.regionProposalsOverlay, 'bbox debug overlay should be retained');
  assert.ok(analysis.debugArtifacts.regionGeometryOverlay, 'geometry-faithful overlay should exist');

  const geometryItems = analysis.debugArtifacts.regionGeometryOverlay.items;
  assert.ok(geometryItems.some(item => item?.geometry?.kind !== 'bbox'), 'geometry overlay should carry non-bbox shapes when available');

  const adapted = WrokitVisionEngine.buildMaps(tokens, viewport, { gray, width: viewport.width, height: viewport.height }, seed.precomputedStructuralMap);
  const visualLayer = adapted?.structuralGraph?.visualRegionLayer;
  assert.equal(visualLayer?.role, 'geometry-faithful-debug', 'visual region layer should advertise geometry-faithful role');
  assert.ok(Array.isArray(visualLayer?.regions) && visualLayer.regions.length > 0, 'visual region layer should include regions');

  const surfaceCandidates = analysis.surfaceCandidates || [];
  assert.ok(surfaceCandidates.length > 0, 'surface candidates should exist');
  assert.ok(surfaceCandidates.every(c => c.surfaceType !== 'panel'), 'panel should no longer be emitted as primary surface type');
  assert.ok(surfaceCandidates.some(c => c.features?.panelLike === true || c.features?.panelLike === false), 'panel-likeness should exist as derived feature');

  console.log('wrokitvision phase 0 visual-first corrections test passed');
})();
