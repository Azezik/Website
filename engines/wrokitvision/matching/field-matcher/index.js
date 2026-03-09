'use strict';

const {
  createFieldMatchResult,
  createMatchCandidate,
  createScoreBreakdown
} = require('../../vision/types');
const CandidateRanking = require('../candidate-ranking');

function normalizeText(text){
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function valueCandidatesFromCandidate(candidate){
  const line = candidate?.lineRef;
  if(!line) return [];
  return [{
    text: normalizeText(line.text),
    normalizedText: normalizeText(line.normalizedText || line.text).toLowerCase(),
    source: 'line-text',
    lineId: line.id,
    tokenIds: line.tokenIds || []
  }].filter((item) => !!item.text);
}

function buildCandidates({ fieldSignature, canonicalPrecomputed } = {}){
  const analysis = canonicalPrecomputed?.uploadedImageAnalysis;
  if(!analysis) return [];

  const blockMap = new Map((analysis.textBlocks || []).map((block) => [block.id, block]));
  const regionMap = new Map((analysis.regionNodes || []).map((region) => [region.id, region]));
  const lineToBlock = new Map();
  for(const block of analysis.textBlocks || []){
    for(const lineId of block.lineIds || []) lineToBlock.set(lineId, block.id);
  }

  const targetPage = Number(fieldSignature?.fieldIdentity?.page || canonicalPrecomputed?.page || 1);
  const seedBox = fieldSignature?.seed?.bbox || null;

  return (analysis.textLines || []).map((line, index) => {
    const blockId = lineToBlock.get(line.id) || null;
    const block = blockId ? blockMap.get(blockId) : null;

    let nearestRegion = null;
    let nearestDist = Infinity;
    const lineBox = line?.geometry?.bbox || {};
    const lc = { x: (lineBox.x || 0) + ((lineBox.w || 0) / 2), y: (lineBox.y || 0) + ((lineBox.h || 0) / 2) };
    for(const region of analysis.regionNodes || []){
      const rb = region?.geometry?.bbox || {};
      const rc = { x: (rb.x || 0) + ((rb.w || 0) / 2), y: (rb.y || 0) + ((rb.h || 0) / 2) };
      const dist = Math.hypot(lc.x - rc.x, lc.y - rc.y);
      if(dist < nearestDist){
        nearestDist = dist;
        nearestRegion = region;
      }
    }

    const seedCenter = seedBox
      ? { x: (Number(seedBox.x) || 0) + ((Number(seedBox.w) || 0) / 2), y: (Number(seedBox.y) || 0) + ((Number(seedBox.h) || 0) / 2) }
      : null;

    return createMatchCandidate({
      candidateId: `line-candidate-${index + 1}`,
      nodeIds: [line.id, block?.id, nearestRegion?.id].filter(Boolean),
      localStructureRefs: {
        lineId: line.id,
        blockId: block?.id || null,
        regionId: nearestRegion?.id || null,
        siblingLineCount: block?.lineIds?.length || 0,
        graphEdgeCount: Number((analysis.textGraph?.edges || []).length || 0)
      },
      regionRef: nearestRegion || null,
      blockRef: block || null,
      lineRef: line,
      tokenRefs: line.tokenIds || [],
      localCoordinateComparison: {
        seedCenter,
        candidateCenter: lc,
        page: targetPage
      },
      extractedValueCandidates: valueCandidatesFromCandidate({ lineRef: line }),
      debug: {
        nearestRegionId: nearestRegion?.id || null,
        nearestRegionDistance: nearestDist
      }
    });
  });
}

function matchFieldSignature({ fieldKey, fieldSignature, canonicalPrecomputed } = {}){
  const analysis = canonicalPrecomputed?.uploadedImageAnalysis;
  if(!analysis || !fieldSignature){
    return createFieldMatchResult({
      fieldKey,
      value: '',
      confidence: 0,
      fallback: { reason: 'missing-signature-or-precomputed-artifact' },
      rationale: createScoreBreakdown({ total: 0, notes: ['signature-matching-skipped'] }),
      debug: { candidateGeneration: [], ranking: null }
    });
  }

  const generatedCandidates = buildCandidates({ fieldSignature, canonicalPrecomputed });
  const rankedResult = CandidateRanking.rankCandidates({
    fieldSignature,
    candidates: generatedCandidates,
    analysis
  });

  const ranked = rankedResult.ranked || [];
  const selected = ranked[0] || null;
  const next = ranked[1] || null;
  const selectedValues = selected?.extractedValueCandidates || [];
  const value = selectedValues[0]?.text || '';
  const confidence = selected?.scoreBreakdown?.confidence || 0;

  const ambiguityGap = selected && next
    ? (selected.scoreBreakdown.weightedScore - next.scoreBreakdown.weightedScore)
    : null;

  return createFieldMatchResult({
    fieldKey,
    selectedCandidate: selected,
    candidates: ranked,
    extractedValueCandidates: selectedValues,
    value,
    confidence,
    ambiguity: {
      hasAmbiguity: ambiguityGap != null ? ambiguityGap < 0.08 : false,
      topScoreGap: ambiguityGap
    },
    rationale: createScoreBreakdown({
      total: confidence,
      components: [
        { key: 'candidateCount', value: ranked.length },
        { key: 'bestWeightedScore', value: selected?.scoreBreakdown?.weightedScore || 0 },
        { key: 'secondBestWeightedScore', value: next?.scoreBreakdown?.weightedScore || 0 }
      ],
      notes: ['field-signature-matching-completed']
    }),
    fallback: selected ? null : { reason: 'no-candidates' },
    debug: {
      candidateGeneration: generatedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        lineId: candidate.localStructureRefs?.lineId,
        blockId: candidate.localStructureRefs?.blockId,
        regionId: candidate.localStructureRefs?.regionId
      })),
      ranking: rankedResult.debug
    }
  });
}

module.exports = {
  matchFieldSignature,
  buildCandidates
};
