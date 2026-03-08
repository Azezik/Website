const assert = require('assert');

const { buildPrecomputedStructuralMap } = require('../engines/wrokitvision/precompute/precompute-orchestrator');
const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

(function run(){
  const tokens = [
    { text: 'Invoice', x: 40, y: 20, w: 56, h: 16, confidence: 0.9 },
    { text: '#', x: 100, y: 20, w: 8, h: 16, confidence: 0.88 },
    { text: '12345', x: 114, y: 20, w: 50, h: 16, confidence: 0.92 },
    { text: 'Total', x: 40, y: 60, w: 42, h: 16, confidence: 0.91 },
    { text: '$99.00', x: 90, y: 60, w: 58, h: 16, confidence: 0.93 }
  ];
  const viewport = { width: 800, height: 1000 };

  const precomputed = buildPrecomputedStructuralMap({ tokens, viewport, page: 1, geometryId: 'geom_1' });
  const analysis = precomputed.uploadedImageAnalysis;

  assert.ok(analysis, 'precompute should return uploaded image analysis');
  assert.ok(Array.isArray(analysis.regionNodes), 'region nodes are present');
  assert.ok(Array.isArray(analysis.textTokens), 'text tokens are present');
  assert.ok(Array.isArray(analysis.textLines), 'text lines are present');
  assert.ok(Array.isArray(analysis.textBlocks), 'text blocks are present');
  assert.ok(Array.isArray(analysis.surfaceCandidates), 'surface candidates are present');
  assert.ok(analysis.regionGraph && Array.isArray(analysis.regionGraph.edges), 'region graph is present');
  assert.ok(analysis.textGraph && Array.isArray(analysis.textGraph.edges), 'text graph is present');
  assert.ok(analysis.debugArtifacts?.regionProposalsOverlay, 'debug overlay exists');

  const seedArtifacts = WrokitVisionEngine.createSeedArtifacts({ tokens, viewport, page: 1, geometryId: 'geom_1' });
  assert.ok(seedArtifacts.precomputedStructuralMap, 'seed artifacts include precomputed map for phase 1 foundation');

  console.log('wrokitvision precompute phase 1 test passed');
})();
