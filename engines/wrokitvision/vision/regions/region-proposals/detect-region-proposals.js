'use strict';

const { createStructuralRegionNode, ensureBBox } = require('../../types');
const { unionBbox } = require('../../text/text-grouping/group-text-lines');

function detectRegionProposals({ textLines = [], viewport, idFactory } = {}){
  const regions = [];
  for(const line of textLines){
    const box = ensureBBox(line.geometry?.bbox || {});
    const padX = Math.max(4, box.h * 0.5);
    const padY = Math.max(2, box.h * 0.25);
    regions.push(createStructuralRegionNode({
      id: idFactory('region'),
      geometry: { bbox: { x: box.x - padX, y: box.y - padY, w: box.w + (padX * 2), h: box.h + (padY * 2) } },
      confidence: line.confidence,
      provenance: { stage: 'region-proposals', detector: 'line-envelope', sourceLineId: line.id },
      features: { sourceLineId: line.id, sourceTokenCount: line.tokenIds?.length || 0 },
      surfaceTypeCandidate: 'text_strip',
      textDensity: 1
    }));
  }

  if(textLines.length){
    const pageTextBounds = unionBbox(textLines.map(line => line.geometry?.bbox || {}));
    regions.push(createStructuralRegionNode({
      id: idFactory('region'),
      geometry: { bbox: pageTextBounds },
      confidence: 0.65,
      provenance: { stage: 'region-proposals', detector: 'text-hull' },
      features: { aggregatedLineCount: textLines.length },
      surfaceTypeCandidate: 'text_cluster',
      textDensity: 0.85
    }));
  }

  if(viewport?.width && viewport?.height){
    regions.push(createStructuralRegionNode({
      id: idFactory('region'),
      geometry: { bbox: { x: 0, y: 0, w: viewport.width, h: viewport.height } },
      confidence: 0.45,
      provenance: { stage: 'region-proposals', detector: 'page-frame' },
      features: { viewportArea: viewport.width * viewport.height },
      surfaceTypeCandidate: 'page_surface',
      textDensity: textLines.length ? 0.3 : 0
    }));
  }

  return regions;
}

module.exports = {
  detectRegionProposals
};
