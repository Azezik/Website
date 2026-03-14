'use strict';

const {
  createUploadedImageAnalysis
} = require('../../types');
const { ingestOcrTokens } = require('../../text/text-detection/ingest-ocr-tokens');
const { groupTextLines } = require('../../text/text-grouping/group-text-lines');
const { groupTextBlocks } = require('../../text/text-grouping/group-text-blocks');
const { detectRegionProposals } = require('../../regions/region-proposals/detect-region-proposals');
const { computeRegionFeatures } = require('../../regions/region-features/compute-region-features');
const { refineRegionCoherence } = require('../../regions/region-refinement/refine-region-coherence');
const { buildRegionGraph } = require('../../regions/region-graph/build-region-graph');
const { buildTextGraph } = require('../../text/text-graph/build-text-graph');
const { detectSurfaceCandidates } = require('../../surfaces/surface-candidates/detect-surface-candidates');
const {
  buildRegionProposalOverlay,
  buildRegionGeometryOverlay,
  buildRegionGraphOverlay,
  buildTextTokenOverlay,
  buildTextLineOverlay,
  buildTextBlockOverlay,
  buildTextGraphOverlay,
  buildSurfaceCandidateOverlay,
  buildAtomicFragmentOverlay
} = require('./debug-artifacts');

function createIdFactory(seed = 'analysis'){
  let index = 0;
  return function next(prefix){
    index += 1;
    return `${seed}_${prefix}_${index}`;
  };
}

function runUploadAnalysis({ tokens = [], viewport = null, page = 1, imageRef = null, analysisId = null, imageData = null } = {}){
  const resolvedViewport = viewport ? {
    width: Number(viewport.width || viewport.w || 0),
    height: Number(viewport.height || viewport.h || 0)
  } : null;

  const idFactory = createIdFactory(analysisId || `p${page}`);
  const textTokens = ingestOcrTokens(tokens, { idFactory, page });
  const textLines = groupTextLines(textTokens, { idFactory });
  const textBlocks = groupTextBlocks(textLines, textTokens, { idFactory });

  const proposalResult = detectRegionProposals({
    textLines,
    viewport: resolvedViewport,
    idFactory,
    imageData
  });
  const proposalRegions = proposalResult.regions || proposalResult;
  const atomicFragments = proposalResult.atomicFragments || [];
  const refinedRegions = refineRegionCoherence(proposalRegions);
  const regionNodes = computeRegionFeatures(refinedRegions, textTokens);
  const regionGraph = buildRegionGraph(regionNodes, { idFactory });
  const textGraph = buildTextGraph({ textTokens, textLines, textBlocks, idFactory });
  const surfaceCandidates = detectSurfaceCandidates(regionNodes, { idFactory });

  const debugArtifacts = {
    regionProposalsOverlay: buildRegionProposalOverlay(regionNodes),
    regionGeometryOverlay: buildRegionGeometryOverlay(regionNodes),
    regionGraphOverlay: buildRegionGraphOverlay(regionGraph),
    textTokensOverlay: buildTextTokenOverlay(textTokens),
    textLinesOverlay: buildTextLineOverlay(textLines),
    textBlocksOverlay: buildTextBlockOverlay(textBlocks),
    textGraphOverlay: buildTextGraphOverlay(textGraph),
    surfaceCandidatesOverlay: buildSurfaceCandidateOverlay(surfaceCandidates),
    atomicFragmentsOverlay: buildAtomicFragmentOverlay(atomicFragments)
  };

  return createUploadedImageAnalysis({
    analysisId: analysisId || `uploaded_${page}_${Date.now()}`,
    imageRef,
    viewport: resolvedViewport,
    regionNodes,
    regionGraph,
    textTokens,
    textLines,
    textBlocks,
    textGraph,
    surfaceCandidates,
    debugArtifacts,
    version: 1
  });
}

module.exports = {
  runUploadAnalysis
};
