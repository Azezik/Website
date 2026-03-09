const assert = require('assert');

const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

(function run(){
  const tokens = [
    { text: 'Invoice', x: 40, y: 20, w: 56, h: 16, confidence: 0.92 },
    { text: 'No', x: 102, y: 20, w: 20, h: 16, confidence: 0.89 },
    { text: 'INV-7788', x: 128, y: 20, w: 82, h: 16, confidence: 0.94 },
    { text: 'Date', x: 40, y: 46, w: 34, h: 16, confidence: 0.9 },
    { text: '2026-01-05', x: 80, y: 46, w: 90, h: 16, confidence: 0.93 },
    { text: 'Total', x: 40, y: 76, w: 42, h: 16, confidence: 0.91 },
    { text: '$125.33', x: 90, y: 76, w: 70, h: 16, confidence: 0.93 }
  ];
  const viewport = { width: 320, height: 220 };

  const seed = WrokitVisionEngine.createSeedArtifacts({
    tokens,
    viewport,
    page: 2,
    geometryId: 'geom_phase3'
  });

  const cfg = WrokitVisionEngine.registerField({
    step: { fieldKey: 'invoice_number' },
    normBox: { x0n: 0.36, y0n: 0.08, wN: 0.40, hN: 0.16 },
    page: 2,
    rawBox: { x: 112, y: 14, w: 120, h: 28 },
    viewport,
    tokens,
    geometryId: 'geom_phase3',
    precomputedStructuralMap: seed.precomputedStructuralMap
  });

  assert.ok(cfg.selectionResolution, 'selection resolution should be attached in register flow');
  assert.equal(cfg.selectionResolution.source, 'typed-canonical-precomputed', 'phase 3 should use typed canonical precomputed source');
  assert.ok(Array.isArray(cfg.selectionResolution.relevanceScores), 'relevance scores should be inspectable');
  assert.ok(cfg.selectionResolution.relevanceScores.some(s => s.nodeType === 'text_token'), 'text token relevance should be scored');
  assert.ok(cfg.selectionResolution.relevanceScores.some(s => s.nodeType === 'structural_region'), 'region relevance should be scored');
  assert.ok(cfg.selectionResolution.resolvedLocalSubgraph, 'resolved local subgraph should be present');
  assert.ok(Array.isArray(cfg.selectionResolution.resolvedLocalSubgraph.retainedTypedEdges), 'resolved subgraph should include typed edges');
  assert.ok(Array.isArray(cfg.selectionResolution.rejectedNodeIds), 'inspectable rejected node ids should be provided');

  const multiProfile = {
    geometryId: 'geom_phase3',
    wrokitVision: {
      geometryArtifacts: {
        geom_phase3: {
          precomputedStructuralMap: { ...seed.precomputedStructuralMap, page: null }
        }
      }
    }
  };

  const cfgWrongPage = WrokitVisionEngine.registerField({
    step: { fieldKey: 'invoice_total' },
    normBox: { x0n: 0.2, y0n: 0.3, wN: 0.3, hN: 0.1 },
    page: 7,
    rawBox: { x: 60, y: 70, w: 110, h: 24 },
    viewport,
    tokens,
    profile: multiProfile,
    geometryId: 'geom_phase3'
  });

  assert.equal(cfgWrongPage.precomputedStructuralMapRef, null, 'artifact without explicit page should not silently match wrong page');

  console.log('wrokitvision phase 3 selection resolution test passed');
})();
