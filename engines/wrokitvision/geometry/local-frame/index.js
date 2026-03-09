'use strict';

const { createLocalCoordinateFrame, createScoreBreakdown } = require('../../vision/types');

function normalizeVector(v){
  const mag = Math.hypot(Number(v?.x) || 0, Number(v?.y) || 0);
  if(mag <= 1e-9) return { x: 1, y: 0 };
  return { x: (Number(v?.x) || 0) / mag, y: (Number(v?.y) || 0) / mag };
}

function perpendicular(v){
  return { x: -v.y, y: v.x };
}

function angleToVector(angleDeg){
  const rad = (Number(angleDeg) || 0) * (Math.PI / 180);
  return normalizeVector({ x: Math.cos(rad), y: Math.sin(rad) });
}

function normalizeAngleDeg(angle){
  const n = Number(angle);
  if(!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}

function circularMeanAngleDeg(angles){
  const normalized = (Array.isArray(angles) ? angles : [])
    .map((value) => normalizeAngleDeg(value))
    .filter((value) => value != null);
  if(!normalized.length) return null;

  const vectorSum = normalized.reduce((acc, angleDeg) => {
    const radians = angleDeg * (Math.PI / 180);
    acc.sin += Math.sin(radians);
    acc.cos += Math.cos(radians);
    return acc;
  }, { sin: 0, cos: 0 });

  const meanSin = vectorSum.sin / normalized.length;
  const meanCos = vectorSum.cos / normalized.length;
  if(Math.abs(meanSin) < 1e-9 && Math.abs(meanCos) < 1e-9) return normalized[0];

  return normalizeAngleDeg(Math.atan2(meanSin, meanCos) * (180 / Math.PI));
}

function estimateLocalCoordinateFrame({ resolvedLocalSubgraph, localStructure } = {}){
  const seed = resolvedLocalSubgraph?.selectionSeed || null;
  const seedBox = seed?.bbox || { x: 0, y: 0, w: 0, h: 0 };

  const lineAngles = (Array.isArray(resolvedLocalSubgraph?.retainedTextLineNodes) ? resolvedLocalSubgraph.retainedTextLineNodes : [])
    .map((line) => normalizeAngleDeg(line?.geometry?.orientation))
    .filter((value) => value != null);

  const regionAngles = (Array.isArray(resolvedLocalSubgraph?.retainedRegionNodes) ? resolvedLocalSubgraph.retainedRegionNodes : [])
    .map((region) => normalizeAngleDeg(region?.geometry?.orientation))
    .filter((value) => value != null);

  let rotationAngle = 0;
  let evidenceSource = 'fallback-seed-axis';

  if(lineAngles.length){
    rotationAngle = circularMeanAngleDeg(lineAngles);
    evidenceSource = 'text-line-orientation';
  } else if(localStructure?.containingBlock?.orientation != null){
    rotationAngle = Number(localStructure.containingBlock.orientation) || 0;
    evidenceSource = 'containing-block-orientation';
  } else if(regionAngles.length){
    rotationAngle = circularMeanAngleDeg(regionAngles);
    evidenceSource = 'region-orientation';
  }

  const primaryAxis = angleToVector(rotationAngle);
  const secondaryAxis = normalizeVector(perpendicular(primaryAxis));
  const origin = { x: seedBox.x + (seedBox.w / 2), y: seedBox.y + (seedBox.h / 2) };

  const transform = {
    toLocalMatrix: [
      [primaryAxis.x, primaryAxis.y, -((origin.x * primaryAxis.x) + (origin.y * primaryAxis.y))],
      [secondaryAxis.x, secondaryAxis.y, -((origin.x * secondaryAxis.x) + (origin.y * secondaryAxis.y))],
      [0, 0, 1]
    ],
    toRawMatrix: [
      [primaryAxis.x, secondaryAxis.x, origin.x],
      [primaryAxis.y, secondaryAxis.y, origin.y],
      [0, 0, 1]
    ],
    helper: 'x_local = dot((x_raw-origin), primaryAxis); y_local = dot((x_raw-origin), secondaryAxis)'
  };

  const confidence = Math.max(0.2, Math.min(0.98,
    (lineAngles.length ? 0.62 : 0)
    + (localStructure?.containingBlock?.orientation != null ? 0.2 : 0)
    + (regionAngles.length ? 0.1 : 0)
    + 0.08
  ));

  return createLocalCoordinateFrame({
    origin,
    primaryAxis,
    secondaryAxis,
    rotationAngle,
    skew: null,
    transform,
    rawGeometry: {
      selectionBox: seedBox,
      containingLine: localStructure?.containingLine?.geometry || null,
      containingBlock: localStructure?.containingBlock?.geometry || null
    },
    confidence,
    rationale: createScoreBreakdown({
      total: confidence,
      components: [
        { key: 'lineOrientationEvidenceCount', value: lineAngles.length },
        { key: 'regionOrientationEvidenceCount', value: regionAngles.length },
        { key: 'evidenceSource', value: evidenceSource }
      ],
      notes: ['local-coordinate-frame-estimated-from-structural-orientation']
    }),
    evidence: {
      source: evidenceSource,
      lineAngles,
      regionAngles
    },
    debug: {
      rotationAngle,
      seedCenter: origin
    }
  });
}

module.exports = {
  estimateLocalCoordinateFrame
};
