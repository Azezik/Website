const assert = require('assert');

const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');
const LocalRelevance = require('../engines/wrokitvision/resolution/local-relevance');

(function run(){
  const viewport = { width: 420, height: 260 };
  const tokens = [
    { text: 'Invoice', x: 30, y: 30, w: 56, h: 16, confidence: 0.92, orientation: 10 },
    { text: '#', x: 90, y: 30, w: 12, h: 16, confidence: 0.92, orientation: 10 },
    { text: 'A-7788', x: 106, y: 30, w: 70, h: 16, confidence: 0.93, orientation: 10 },
    { text: 'Total', x: 30, y: 68, w: 42, h: 16, confidence: 0.9, orientation: 10 },
    { text: '$95.44', x: 80, y: 68, w: 62, h: 16, confidence: 0.91, orientation: 10 }
  ];

  const artifacts = WrokitVisionEngine.createSeedArtifacts({
    tokens,
    viewport,
    page: 1,
    geometryId: 'geom_phase4'
  });

  const cfg = WrokitVisionEngine.registerField({
    step: { fieldKey: 'invoice_number' },
    normBox: { x0n: 0.23, y0n: 0.09, wN: 0.35, hN: 0.12 },
    page: 1,
    rawBox: { x: 94, y: 24, w: 120, h: 28 },
    viewport,
    tokens,
    geometryId: 'geom_phase4',
    precomputedStructuralMap: artifacts.precomputedStructuralMap
  });

  assert.ok(cfg.selectionResolution?.localStructure, 'local structure should be included in selection resolution');
  assert.ok(cfg.selectionResolution?.localCoordinateFrame, 'local coordinate frame should be included in selection resolution');
  assert.ok(cfg.selectionResolution?.fieldSignature, 'field signature should be included in selection resolution');
  assert.ok(cfg.fieldSignature, 'field signature should be promoted for persistence');
  assert.equal(cfg.fieldSignature.schema, 'wrokitvision/field-signature/v1', 'field signature schema should be versioned');
  assert.ok(Array.isArray(cfg.fieldSignature.anchorTokens), 'field signature should include anchor tokens');
  assert.ok(Array.isArray(cfg.fieldSignature.nearbyLabels), 'field signature should include nearby labels');

  const analysis = artifacts.precomputedStructuralMap.uploadedImageAnalysis;
  const selectionResolution = cfg.selectionResolution;
  const relevance = LocalRelevance.scoreLocalRelevance({
    canonicalPrecomputed: artifacts.precomputedStructuralMap,
    selectionSeed: selectionResolution.selectionSeed,
    selectionContext: selectionResolution.selectionContext
  });

  const tokenScores = relevance.nodeScores.filter((score) => score.nodeType === 'text_token');
  assert.ok(tokenScores.length > 0, 'token scores should exist');
  assert.ok(tokenScores.some((score) => score.scoreComponents.alignmentSource), 'alignment source should be inspectable');
  assert.ok(tokenScores.some((score) => Object.prototype.hasOwnProperty.call(score.scoreComponents, 'alignmentAngleDelta')), 'angular difference should be inspectable');

  const firstToken = analysis.textTokens[0];
  const rotatedClone = { ...firstToken, id: 'tok_rotated_180', geometry: { ...firstToken.geometry, orientation: 190 } };
  const enhanced = {
    ...artifacts.precomputedStructuralMap,
    uploadedImageAnalysis: {
      ...analysis,
      textTokens: [...analysis.textTokens, rotatedClone]
    }
  };
  const relevanceWithRotated = LocalRelevance.scoreLocalRelevance({
    canonicalPrecomputed: enhanced,
    selectionSeed: selectionResolution.selectionSeed,
    selectionContext: selectionResolution.selectionContext
  });

  const scoreNear = relevanceWithRotated.nodeScores.find((s) => s.nodeId === firstToken.id);
  const scoreFar = relevanceWithRotated.nodeScores.find((s) => s.nodeId === rotatedClone.id);
  assert.ok(scoreNear && scoreFar, 'comparison scores should exist');
  assert.ok(scoreNear.scoreComponents.alignment > scoreFar.scoreComponents.alignment, 'close orientation should score higher than opposite orientation');

  console.log('wrokitvision phase4 local structure/frame/signature test passed');
})();
