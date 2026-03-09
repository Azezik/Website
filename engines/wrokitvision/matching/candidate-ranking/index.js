'use strict';

const { createMatchScoreBreakdown, createScoreBreakdown } = require('../../vision/types');

function clamp01(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeText(text){
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokensFromLine(line, tokenMap){
  if(!line) return [];
  return (line.tokenIds || []).map((id) => tokenMap.get(id)).filter(Boolean);
}

function jaccardText(a, b){
  const aa = new Set(normalizeText(a).split(/\s+/g).filter(Boolean));
  const bb = new Set(normalizeText(b).split(/\s+/g).filter(Boolean));
  if(!aa.size || !bb.size) return 0;
  let inter = 0;
  for(const token of aa) if(bb.has(token)) inter += 1;
  const union = aa.size + bb.size - inter;
  return union > 0 ? inter / union : 0;
}

function rankCandidates({ fieldSignature, candidates, analysis } = {}){
  const tokenMap = new Map((analysis?.textTokens || []).map((t) => [t.id, t]));
  const regionMap = new Map((analysis?.regionNodes || []).map((r) => [r.id, r]));

  const weights = {
    anchorTextSimilarity: 0.2,
    nearbyLabelSimilarity: 0.17,
    structuralSimilarity: 0.14,
    containingRegionSimilarity: 0.1,
    siblingArrangementSimilarity: 0.1,
    localGeometrySimilarity: 0.17,
    graphRelationshipSimilarity: 0.12
  };

  const ranked = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const line = candidate.lineRef;
    const block = candidate.blockRef;
    const region = candidate.regionRef || regionMap.get(candidate.localStructureRefs?.regionId) || null;
    const lineTokens = tokensFromLine(line, tokenMap);
    const lineText = line?.text || lineTokens.map((t) => t.text).join(' ');

    const anchorNorms = (fieldSignature?.anchorTokens || []).map((a) => normalizeText(a.normalizedText || a.text));
    const lineNorm = normalizeText(lineText);
    const anchorTextSimilarity = anchorNorms.length
      ? anchorNorms.reduce((m, a) => Math.max(m, a && lineNorm ? (lineNorm.includes(a) || a.includes(lineNorm) ? 1 : jaccardText(a, lineNorm)) : 0), 0)
      : 0;

    const labelNorms = (fieldSignature?.nearbyLabels || []).map((l) => normalizeText(l.normalizedText || l.text));
    const nearbyLabelSimilarity = labelNorms.length
      ? labelNorms.reduce((m, l) => Math.max(m, l && lineNorm ? jaccardText(l, lineNorm) : 0), 0)
      : 0;

    const expectedLine = fieldSignature?.structuralRelationships?.containingLine?.id;
    const expectedBlock = fieldSignature?.structuralRelationships?.containingBlock?.id;
    const structuralSimilarity = clamp01((expectedLine && line?.id === expectedLine ? 0.6 : 0) + (expectedBlock && block?.id === expectedBlock ? 0.4 : 0));

    const expectedRegionId = fieldSignature?.containingRegions?.[0]?.id || null;
    const containingRegionSimilarity = expectedRegionId && region?.id === expectedRegionId ? 1 : 0;

    const sigSiblingLines = fieldSignature?.siblingStructures?.lines?.length || 0;
    const candSiblingLines = candidate.localStructureRefs?.siblingLineCount || 0;
    const siblingArrangementSimilarity = sigSiblingLines || candSiblingLines
      ? clamp01(1 - (Math.abs(sigSiblingLines - candSiblingLines) / Math.max(1, sigSiblingLines, candSiblingLines)))
      : 0.5;

    const sigCenter = fieldSignature?.seed?.bbox
      ? {
          x: (Number(fieldSignature.seed.bbox.x) || 0) + ((Number(fieldSignature.seed.bbox.w) || 0) / 2),
          y: (Number(fieldSignature.seed.bbox.y) || 0) + ((Number(fieldSignature.seed.bbox.h) || 0) / 2)
        }
      : null;
    const candBox = line?.geometry?.bbox || block?.geometry?.bbox || region?.geometry?.bbox || null;
    const candCenter = candBox
      ? { x: (candBox.x || 0) + ((candBox.w || 0) / 2), y: (candBox.y || 0) + ((candBox.h || 0) / 2) }
      : null;
    const vpW = Number(analysis?.viewport?.width || 1);
    const vpH = Number(analysis?.viewport?.height || 1);
    const localGeometrySimilarity = (sigCenter && candCenter)
      ? clamp01(1 - Math.hypot((candCenter.x - sigCenter.x) / vpW, (candCenter.y - sigCenter.y) / vpH))
      : 0.4;

    const sigEdges = fieldSignature?.graphRelationships?.length || 0;
    const candEdgeCount = candidate.localStructureRefs?.graphEdgeCount || 0;
    const graphRelationshipSimilarity = sigEdges || candEdgeCount
      ? clamp01(1 - (Math.abs(sigEdges - candEdgeCount) / Math.max(1, sigEdges, candEdgeCount)))
      : 0.5;

    const signals = {
      anchorTextSimilarity,
      nearbyLabelSimilarity,
      structuralSimilarity,
      containingRegionSimilarity,
      siblingArrangementSimilarity,
      localGeometrySimilarity,
      graphRelationshipSimilarity
    };

    const weightedScore = Object.keys(weights).reduce((sum, key) => sum + ((signals[key] || 0) * weights[key]), 0);
    const confidence = clamp01((weightedScore * 0.92) + 0.05);

    candidate.scoreBreakdown = createMatchScoreBreakdown({
      totalScore: weightedScore,
      weightedScore,
      confidence,
      signals,
      weights,
      rationale: createScoreBreakdown({
        total: weightedScore,
        components: Object.keys(signals).map((key) => ({ key, value: signals[key] })),
        notes: ['candidate-ranked-using-text-structure-geometry-graph-cues']
      })
    });

    return candidate;
  }).sort((a, b) => (b.scoreBreakdown?.weightedScore || 0) - (a.scoreBreakdown?.weightedScore || 0));

  return {
    ranked,
    debug: {
      candidateCount: ranked.length,
      weights
    }
  };
}

module.exports = {
  rankCandidates
};
