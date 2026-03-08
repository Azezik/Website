'use strict';

const { createSurfaceCandidate, ensureBBox } = require('../../types');

function detectSurfaceCandidates(regionNodes = [], { idFactory } = {}){
  return regionNodes
    .map(region => {
      const box = ensureBBox(region.geometry?.bbox || {});
      const area = box.w * box.h;
      const isLarge = area > 40000;
      const textDensity = Number(region.textDensity) || 0;
      const isPanel = isLarge && textDensity < 0.35;
      const surfaceType = isPanel ? 'panel' : (textDensity > 0.55 ? 'text_dense_surface' : 'mixed_surface');
      const confidence = Math.max(0.25, Math.min(0.95, (Number(region.confidence) || 0.5) * 0.8 + (isLarge ? 0.15 : 0)));
      return createSurfaceCandidate({
        id: idFactory('surface'),
        geometry: { bbox: box },
        confidence,
        provenance: { stage: 'surface-candidates', detector: 'region-surface-heuristic', sourceRegionId: region.id },
        surfaceType,
        features: { regionArea: area, textDensity },
        supportingRegionIds: [region.id]
      });
    })
    .filter(candidate => candidate.features.regionArea > 2000);
}

module.exports = {
  detectSurfaceCandidates
};
