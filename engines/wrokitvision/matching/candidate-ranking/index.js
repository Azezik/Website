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

function safeBBox(box){
  return {
    x: Number(box?.x) || 0,
    y: Number(box?.y) || 0,
    w: Math.max(0, Number(box?.w) || 0),
    h: Math.max(0, Number(box?.h) || 0)
  };
}

function center(box){
  const b = safeBBox(box);
  return { x: b.x + (b.w / 2), y: b.y + (b.h / 2) };
}

function normalizedPointInBox(point, box){
  const b = safeBBox(box);
  if(!b.w || !b.h) return null;
  return {
    x: clamp01((point.x - b.x) / b.w),
    y: clamp01((point.y - b.y) / b.h)
  };
}

function geometrySimilarity(a, b, viewport = {}){
  if(!a || !b) return 0;
  const boxA = safeBBox(a);
  const boxB = safeBBox(b);
  const vpW = Math.max(1, Number(viewport.width) || 1);
  const vpH = Math.max(1, Number(viewport.height) || 1);

  const sizeX = 1 - (Math.abs(boxA.w - boxB.w) / Math.max(1, boxA.w, boxB.w));
  const sizeY = 1 - (Math.abs(boxA.h - boxB.h) / Math.max(1, boxA.h, boxB.h));
  const ratioA = boxA.h > 0 ? boxA.w / boxA.h : 0;
  const ratioB = boxB.h > 0 ? boxB.w / boxB.h : 0;
  const ratio = ratioA > 0 && ratioB > 0
    ? 1 - (Math.abs(ratioA - ratioB) / Math.max(1, ratioA, ratioB))
    : 0;

  const dist = Math.hypot((center(boxA).x - center(boxB).x) / vpW, (center(boxA).y - center(boxB).y) / vpH);
  const position = clamp01(1 - dist);

  return clamp01((clamp01(sizeX) * 0.25) + (clamp01(sizeY) * 0.25) + (clamp01(ratio) * 0.2) + (position * 0.3));
}

function distributionSimilarity(a = {}, b = {}){
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if(!keys.size) return 0.5;
  let overlap = 0;
  for(const key of keys) overlap += Math.min(Number(a[key]) || 0, Number(b[key]) || 0);
  return clamp01(overlap);
}

function histogram(values = []){
  const counts = {};
  for(const value of values){
    if(!value) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if(!total) return {};
  Object.keys(counts).forEach((key) => {
    counts[key] = counts[key] / total;
  });
  return counts;
}

function buildLocalGraphProfile({ candidate, analysis } = {}){
  const nodeIds = new Set(candidate?.nodeIds || []);
  for(const tokenId of candidate?.lineRef?.tokenIds || []) nodeIds.add(tokenId);
  for(const lineId of candidate?.blockRef?.lineIds || []) nodeIds.add(lineId);

  const textEdges = analysis?.textGraph?.edges || [];
  const regionEdges = analysis?.regionGraph?.edges || [];
  const edges = [...textEdges, ...regionEdges].filter((edge) => nodeIds.has(edge.sourceNodeId) || nodeIds.has(edge.targetNodeId));
  const edgeTypeDistribution = histogram(edges.map((edge) => edge.edgeType));
  const edgeDensity = nodeIds.size ? (edges.length / nodeIds.size) : 0;

  return {
    edgeCount: edges.length,
    nodeCount: nodeIds.size,
    edgeDensity,
    edgeTypeDistribution
  };
}

function graphRelationshipSimilarity({ signatureRelationships, candidate, analysis } = {}){
  const sigEdges = Array.isArray(signatureRelationships) ? signatureRelationships : [];
  const sigDistribution = histogram(sigEdges.map((edge) => edge?.edgeType));
  const sigNodes = new Set();
  for(const edge of sigEdges){
    if(edge?.sourceNodeId) sigNodes.add(edge.sourceNodeId);
    if(edge?.targetNodeId) sigNodes.add(edge.targetNodeId);
  }
  const sigDensity = sigNodes.size ? (sigEdges.length / sigNodes.size) : 0;
  const candidateProfile = buildLocalGraphProfile({ candidate, analysis });

  const typedPatternSimilarity = distributionSimilarity(sigDistribution, candidateProfile.edgeTypeDistribution);
  const densitySimilarity = (sigDensity || candidateProfile.edgeDensity)
    ? clamp01(1 - (Math.abs(sigDensity - candidateProfile.edgeDensity) / Math.max(1, sigDensity, candidateProfile.edgeDensity)))
    : 0.5;

  return {
    score: clamp01((typedPatternSimilarity * 0.7) + (densitySimilarity * 0.3)),
    details: {
      signature: {
        edgeCount: sigEdges.length,
        nodeCount: sigNodes.size,
        edgeDensity: sigDensity,
        edgeTypeDistribution: sigDistribution
      },
      candidate: candidateProfile,
      typedPatternSimilarity,
      densitySimilarity
    }
  };
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

    const sigLineText = fieldSignature?.structuralRelationships?.containingLine?.text || '';
    const sigBlockText = fieldSignature?.structuralRelationships?.containingBlock?.text || '';
    const lineTextSimilarity = sigLineText && lineText ? jaccardText(sigLineText, lineText) : 0;
    const blockTextSimilarity = sigBlockText && block?.text ? jaccardText(sigBlockText, block.text) : 0;

    const sigLineBox = fieldSignature?.localGeometry?.localStructure?.containingLineBBox || null;
    const sigBlockBox = fieldSignature?.localGeometry?.localStructure?.containingBlockBBox || null;
    const candLineBox = line?.geometry?.bbox || null;
    const candBlockBox = block?.geometry?.bbox || null;
    let relativePlacementSimilarity = 0;
    if(sigLineBox && sigBlockBox && candLineBox && candBlockBox){
      const sigRel = normalizedPointInBox(center(sigLineBox), sigBlockBox);
      const candRel = normalizedPointInBox(center(candLineBox), candBlockBox);
      if(sigRel && candRel){
        relativePlacementSimilarity = clamp01(1 - Math.hypot(sigRel.x - candRel.x, sigRel.y - candRel.y));
      }
    }

    const structuralSimilarity = clamp01((lineTextSimilarity * 0.45) + (blockTextSimilarity * 0.25) + (relativePlacementSimilarity * 0.3));

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


    const sigRegion = fieldSignature?.containingRegions?.[0] || null;
    const sigRegionBox = sigRegion?.geometry?.bbox || null;
    const candRegionBox = region?.geometry?.bbox || null;
    const regionGeometrySimilarity = geometrySimilarity(sigRegionBox, candRegionBox, analysis?.viewport || {});

    let regionPlacementSimilarity = 0;
    if(sigRegionBox && candRegionBox && sigCenter && candCenter){
      const sigSeedRel = normalizedPointInBox(sigCenter, sigRegionBox);
      const candRel = normalizedPointInBox(candCenter, candRegionBox);
      if(sigSeedRel && candRel){
        regionPlacementSimilarity = clamp01(1 - Math.hypot(sigSeedRel.x - candRel.x, sigSeedRel.y - candRel.y));
      }
    }

    let regionLineRelationSimilarity = 0;
    if(sigRegionBox && candRegionBox && sigLineBox && candLineBox){
      const sigLineRel = normalizedPointInBox(center(sigLineBox), sigRegionBox);
      const candLineRel = normalizedPointInBox(center(candLineBox), candRegionBox);
      if(sigLineRel && candLineRel){
        regionLineRelationSimilarity = clamp01(1 - Math.hypot(sigLineRel.x - candLineRel.x, sigLineRel.y - candLineRel.y));
      }
    }

    const containingRegionSimilarity = clamp01(
      (regionGeometrySimilarity * 0.4)
      + (regionPlacementSimilarity * 0.4)
      + (regionLineRelationSimilarity * 0.2)
    );

    const sigSiblingLines = fieldSignature?.siblingStructures?.lines?.length || 0;
    const candSiblingLines = candidate.localStructureRefs?.siblingLineCount || 0;
    const siblingArrangementSimilarity = sigSiblingLines || candSiblingLines
      ? clamp01(1 - (Math.abs(sigSiblingLines - candSiblingLines) / Math.max(1, sigSiblingLines, candSiblingLines)))
      : 0.5;

    const vpW = Number(analysis?.viewport?.width || 1);
    const vpH = Number(analysis?.viewport?.height || 1);
    const localGeometrySimilarity = (sigCenter && candCenter)
      ? clamp01(1 - Math.hypot((candCenter.x - sigCenter.x) / vpW, (candCenter.y - sigCenter.y) / vpH))
      : 0.4;

    const graphSimilarity = graphRelationshipSimilarity({
      signatureRelationships: fieldSignature?.graphRelationships,
      candidate,
      analysis
    });
    const graphRelationshipSimilarityScore = graphSimilarity.score;

    const signals = {
      anchorTextSimilarity,
      nearbyLabelSimilarity,
      structuralSimilarity,
      containingRegionSimilarity,
      siblingArrangementSimilarity,
      localGeometrySimilarity,
      graphRelationshipSimilarity: graphRelationshipSimilarityScore
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
        components: [
          ...Object.keys(signals).map((key) => ({ key, value: signals[key] })),
          { key: 'graphTypedPatternSimilarity', value: graphSimilarity.details.typedPatternSimilarity },
          { key: 'graphDensitySimilarity', value: graphSimilarity.details.densitySimilarity }
        ],
        notes: ['candidate-ranked-using-text-structure-geometry-graph-cues']
      })
    });

    candidate.debug = {
      ...(candidate.debug || {}),
      structuralSimilarity: {
        lineTextSimilarity,
        blockTextSimilarity,
        relativePlacementSimilarity
      },
      containingRegionSimilarity: {
        regionGeometrySimilarity,
        regionPlacementSimilarity,
        regionLineRelationSimilarity
      },
      graphRelationshipSimilarity: graphSimilarity.details
    };

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
