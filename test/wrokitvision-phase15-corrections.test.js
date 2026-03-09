const assert = require('assert');

const WrokitVisionEngine = require('../engines/core/wrokit-vision-engine');

(function run(){
  const tokens = [
    { text: 'Invoice', x: 40, y: 20, w: 56, h: 16, confidence: 0.9 },
    { text: 'No', x: 100, y: 20, w: 20, h: 16, confidence: 0.88 },
    { text: 'A-12345', x: 124, y: 20, w: 70, h: 16, confidence: 0.92 },
    { text: 'Total', x: 40, y: 60, w: 42, h: 16, confidence: 0.91 },
    { text: '$99.00', x: 90, y: 60, w: 58, h: 16, confidence: 0.93 }
  ];
  const viewport = { width: 240, height: 140 };

  const gray = new Uint8Array(viewport.width * viewport.height).fill(245);
  for(let y = 15; y < 95; y++){
    for(let x = 150; x < 230; x++) gray[(y * viewport.width) + x] = 45;
  }

  const seed = WrokitVisionEngine.createSeedArtifacts({
    tokens,
    viewport,
    page: 1,
    geometryId: 'geom_phase15',
    imageData: { gray, width: viewport.width, height: viewport.height }
  });

  const precomputed = seed.precomputedStructuralMap;
  assert.ok(precomputed?.uploadedImageAnalysis, 'precomputed map should exist');

  const ocrRegions = precomputed.uploadedImageAnalysis.regionNodes.filter(r => r?.provenance?.sourceType === 'ocr');
  const visualRegions = precomputed.uploadedImageAnalysis.regionNodes.filter(r => r?.provenance?.sourceType === 'visual');
  assert.ok(ocrRegions.length > 0, 'should include ocr-derived regions');
  assert.ok(visualRegions.length > 0, 'should include non-ocr visual-derived regions');

  const fieldSpec = {
    fieldKey: 'invoice_number',
    page: 1,
    wrokitVisionConfig: {
      viewport,
      neighborhoods: {
        textNeighbors: [{ text: 'invoice' }],
        structuralNeighbors: [],
        visualRegionContext: null
      }
    }
  };

  const profile = {
    geometryId: 'geom_phase15',
    fields: [{ fieldKey: 'invoice_number', wrokitVisionConfig: fieldSpec.wrokitVisionConfig }],
    wrokitVision: {
      geometryArtifacts: {
        geom_phase15: {
          precomputedStructuralMap: precomputed
        }
      }
    }
  };

  const registerCfg = WrokitVisionEngine.registerField({
    step: fieldSpec,
    normBox: { x0n: 0.45, y0n: 0.1, wN: 0.35, hN: 0.2 },
    page: 1,
    rawBox: { x: 95, y: 10, w: 95, h: 28 },
    viewport,
    tokens,
    profile,
    geometryId: 'geom_phase15',
    precomputedStructuralMap: precomputed
  });

  assert.equal(registerCfg.precomputedStructuralMapRef?.schema, 'wrokitvision/precomputed-structural-map/v1', 'registerField should link precomputed map');

  const extract = WrokitVisionEngine.extractScalar({
    fieldSpec,
    tokens,
    boxPx: { x: 95, y: 10, w: 110, h: 28 },
    viewport,
    profile,
    geometryId: 'geom_phase15',
    precomputedStructuralMap: precomputed
  });

  assert.ok(String(extract.raw || '').includes('A-12345'), 'extractScalar should read value via precomputed-backed maps');

  console.log('wrokitvision phase 1.5 corrections test passed');
})();
