const assert = require('assert');

const { estimateLocalCoordinateFrame } = require('../engines/wrokitvision/geometry/local-frame');

(function run(){
  const frame = estimateLocalCoordinateFrame({
    resolvedLocalSubgraph: {
      selectionSeed: { bbox: { x: 100, y: 40, w: 20, h: 20 } },
      retainedTextLineNodes: [
        { geometry: { orientation: 355 } },
        { geometry: { orientation: 5 } }
      ],
      retainedRegionNodes: []
    },
    localStructure: {
      containingBlock: { orientation: 0 }
    }
  });

  assert.ok(frame.rotationAngle <= 10 || frame.rotationAngle >= 350, 'circular mean should stay near 0° around wrap boundary');
  assert.equal(frame.evidence.source, 'text-line-orientation', 'line angles should drive orientation source');

  const frame2 = estimateLocalCoordinateFrame({
    resolvedLocalSubgraph: {
      selectionSeed: { bbox: { x: 0, y: 0, w: 10, h: 10 } },
      retainedTextLineNodes: [],
      retainedRegionNodes: [
        { geometry: { orientation: 358 } },
        { geometry: { orientation: 2 } }
      ]
    },
    localStructure: {}
  });
  assert.ok(frame2.rotationAngle <= 10 || frame2.rotationAngle >= 350, 'region fallback should also use circular mean');

  console.log('wrokitvision local frame wraparound test passed');
})();
