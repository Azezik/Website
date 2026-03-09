const assert = require('assert');

const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

(function run(){
  const viewport = { width: 420, height: 260 };
  const configTokens = [
    { id: 'c1', text: 'Invoice', x: 20, y: 30, w: 52, h: 16, confidence: 0.95, orientation: 0 },
    { id: 'c2', text: '#', x: 74, y: 30, w: 8, h: 16, confidence: 0.9, orientation: 0 },
    { id: 'c3', text: 'INV-9912', x: 86, y: 30, w: 80, h: 16, confidence: 0.96, orientation: 0 },
    { id: 'c4', text: 'Total', x: 20, y: 70, w: 40, h: 16, confidence: 0.93, orientation: 0 },
    { id: 'c5', text: '$41.00', x: 66, y: 70, w: 58, h: 16, confidence: 0.94, orientation: 0 }
  ];

  const seedArtifacts = WrokitVisionEngine.createSeedArtifacts({
    tokens: configTokens,
    viewport,
    page: 1,
    geometryId: 'geom_match_1'
  });

  const cfg = WrokitVisionEngine.registerField({
    step: { fieldKey: 'invoice_number', fieldType: 'static' },
    normBox: { x0n: 0.18, y0n: 0.1, wN: 0.3, hN: 0.1 },
    page: 1,
    rawBox: { x: 80, y: 24, w: 98, h: 28 },
    viewport,
    tokens: configTokens,
    geometryId: 'geom_match_1',
    precomputedStructuralMap: seedArtifacts.precomputedStructuralMap
  });

  const runtimeTokens = [
    { id: 'r1', text: 'Invoice', x: 24, y: 34, w: 52, h: 16, confidence: 0.95, orientation: 0 },
    { id: 'r2', text: '#', x: 80, y: 34, w: 8, h: 16, confidence: 0.9, orientation: 0 },
    { id: 'r3', text: 'INV-9921', x: 92, y: 34, w: 78, h: 16, confidence: 0.96, orientation: 0 },
    { id: 'r4', text: 'Invoice', x: 240, y: 160, w: 52, h: 16, confidence: 0.95, orientation: 0 },
    { id: 'r5', text: '#', x: 296, y: 160, w: 8, h: 16, confidence: 0.9, orientation: 0 },
    { id: 'r6', text: 'INV-0000', x: 308, y: 160, w: 78, h: 16, confidence: 0.96, orientation: 0 }
  ];

  const runtimeArtifacts = WrokitVisionEngine.createSeedArtifacts({
    tokens: runtimeTokens,
    viewport,
    page: 1,
    geometryId: 'geom_match_1'
  });

  const result = WrokitVisionEngine.extractScalar({
    fieldSpec: {
      fieldKey: 'invoice_number',
      page: 1,
      wrokitVisionConfig: cfg
    },
    tokens: runtimeTokens,
    boxPx: { x: 78, y: 24, w: 110, h: 34 },
    viewport,
    geometryId: 'geom_match_1',
    precomputedStructuralMap: runtimeArtifacts.precomputedStructuralMap
  });

  assert.equal(result.method, 'wrokit-vision-field-signature-match', 'runtime should use field-signature matching when available');
  assert.ok(String(result.raw || '').includes('INV-9921'), 'best local match should be selected from candidates');
  assert.ok(result.matching, 'matching debug object should be returned');
  assert.ok(Array.isArray(result.matching.candidates) && result.matching.candidates.length >= 2, 'candidate ranking should include multiple candidates');
  assert.ok(result.matching.selectedCandidate.scoreBreakdown.signals.anchorTextSimilarity >= 0, 'score breakdown should expose inspectable signals');

  console.log('wrokitvision phase5 future matching test passed');
})();
