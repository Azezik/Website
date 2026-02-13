(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineFindTextRanker = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const normalizeMatchText = (text) => String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizeMatchToken = (text) => normalizeMatchText(text).replace(/\s+/g, '');
  const getQueryParts = (query) => {
    const normalized = normalizeMatchText(query);
    return normalized ? normalized.split(' ').filter(Boolean) : [];
  };

  const looksLikeEmail = (text) => /@/.test(text);
  const looksLikeUrl = (text) => /\bhttps?:\/\/|www\./i.test(text);
  const isNumericOnly = (text) => /^[\d.,-]+$/.test(String(text || '').trim());
  const isMixedAlnum = (text) => /[\d]/.test(text) && /[a-z]/i.test(text);

  function scoreFindTextTokenMatch(candidateNorm, partNorm){
    if(!candidateNorm || !partNorm) return 0;
    if(candidateNorm === partNorm) return 3;
    if(candidateNorm.startsWith(partNorm)) return 2;
    if(candidateNorm.includes(partNorm)) return 1;
    if(partNorm.includes(candidateNorm)) return 0.5;
    return 0;
  }

  function scoreFindTextCandidate(tokens, partNorms, querySquashed){
    const tokenText = tokens.map(t => String(t.text || t.raw || '')).join(' ');
    const tokenNorms = tokens.map(t => normalizeMatchToken(t.text || t.raw || ''));
    let score = 0;
    if(tokenNorms.length === 1 && querySquashed){
      score += scoreFindTextTokenMatch(tokenNorms[0], querySquashed);
    }
    for(let i=0; i<partNorms.length && i<tokenNorms.length; i++){
      score += scoreFindTextTokenMatch(tokenNorms[i], partNorms[i]);
    }
    if(/@/.test(tokenText)) score -= 2;
    if(/\bhttps?:\/\/|www\./i.test(tokenText)) score -= 1;
    if(/[\d]/.test(tokenText) && /[a-z]/i.test(tokenText)) score -= 0.5;
    return score;
  }

  function extractFeatures(query, candidate, context = {}){
    const tokens = candidate?.tokens || [];
    const tokenTexts = tokens.map(t => String(t.text || t.raw || '')).filter(Boolean);
    const tokenNorms = tokens.map(t => normalizeMatchToken(t.text || t.raw || ''));
    const queryParts = getQueryParts(query);
    const queryNorms = queryParts.map(part => normalizeMatchToken(part));
    const querySquashed = queryNorms.join('');
    const candidateText = tokenTexts.join(' ');

    let exactMatchCount = 0;
    let startsWithCount = 0;
    let substringCount = 0;
    tokenNorms.forEach((norm, idx) => {
      const part = queryNorms[idx] || '';
      if(!norm || !part) return;
      if(norm === part) exactMatchCount += 1;
      else if(norm.startsWith(part)) startsWithCount += 1;
      else if(norm.includes(part) || part.includes(norm)) substringCount += 1;
    });

    const confidenceVals = tokens.map(t => Number.isFinite(t.confidence) ? t.confidence : null).filter(Number.isFinite);
    const avgConf = confidenceVals.length ? confidenceVals.reduce((s,v)=> s + v, 0) / confidenceVals.length : null;
    const minConf = confidenceVals.length ? Math.min(...confidenceVals) : null;
    const box = candidate?.box || {};

    return {
      tokenCount: tokenTexts.length,
      charLength: candidateText.length,
      wordCount: candidateText ? candidateText.split(/\s+/g).filter(Boolean).length : 0,
      exactMatchCount,
      startsWithCount,
      substringCount,
      queryCharLength: querySquashed.length,
      looksLikeEmail: looksLikeEmail(candidateText) ? 1 : 0,
      looksLikeUrl: looksLikeUrl(candidateText) ? 1 : 0,
      isNumericOnly: isNumericOnly(candidateText) ? 1 : 0,
      isMixedAlnum: isMixedAlnum(candidateText) ? 1 : 0,
      boxWidth: Number.isFinite(box.w) ? box.w : 0,
      boxHeight: Number.isFinite(box.h) ? box.h : 0,
      sourceIsPdfjs: context.source === 'pdfjs' ? 1 : 0,
      sourceIsTesseract: context.source === 'tesseract' || context.source === 'tesseract-bbox' ? 1 : 0,
      tessMinConfidence: minConf,
      tessAvgConfidence: avgConf
    };
  }

  function scoreCandidate(features, weights, fallbackScore = 0){
    if(!weights || typeof weights !== 'object') return fallbackScore;
    let score = Number.isFinite(weights.bias) ? weights.bias : 0;
    Object.entries(features || {}).forEach(([key, value]) => {
      if(!Number.isFinite(value)) return;
      const w = Number.isFinite(weights[key]) ? weights[key] : 0;
      score += w * value;
    });
    return score;
  }

  function rankCandidates(candidates, options = {}){
    const { query = '', source = '', weights = null, fallbackKey = 'score' } = options;
    const ranked = (candidates || []).map((candidate, idx) => {
      const features = extractFeatures(query, candidate, { source });
      const fallbackScore = Number.isFinite(candidate?.[fallbackKey]) ? candidate[fallbackKey] : 0;
      const learnedScore = scoreCandidate(features, weights, fallbackScore);
      return { ...candidate, _ranker: { index: idx, features, learnedScore, fallbackScore } };
    });
    ranked.sort((a,b)=> (b._ranker.learnedScore - a._ranker.learnedScore) || (a.order - b.order));
    return ranked;
  }

  function rankFindTextCandidates(candidates, options = {}){
    const { mode = 'first', query = '', source = '', useRanker = false, weights = null, learnedRanker = null } = options || {};
    let ranked = (candidates || []).slice();
    let rankedBy = 'order';
    if(mode === 'best'){
      if(useRanker && weights && learnedRanker?.rankCandidates){
        ranked = learnedRanker.rankCandidates(candidates, { query, source, weights, fallbackKey: 'score' });
        rankedBy = 'learned';
      } else {
        ranked.sort((a,b)=> (b.score - a.score) || (a.order - b.order));
        rankedBy = 'heuristic';
      }
    } else {
      ranked.sort((a,b)=> a.order - b.order);
    }
    return { ranked, chosen: ranked[0] || null, rankedBy };
  }

  return {
    normalizeMatchText,
    normalizeMatchToken,
    getQueryParts,
    scoreFindTextTokenMatch,
    scoreFindTextCandidate,
    extractFeatures,
    scoreCandidate,
    rankCandidates,
    rankFindTextCandidates
  };
});
