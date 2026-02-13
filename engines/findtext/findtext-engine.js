(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineFindText = factory(root.EngineFindTextRanker || null);
  }
})(typeof self !== 'undefined' ? self : this, function(defaultRankerEngine){
  const normalizeFindTextInput = (text) => String(text || '').trim().replace(/\s+/g, ' ');

  function isFindTextTokenMatch(candidateNorm, partNorm){
    if(!candidateNorm || !partNorm) return false;
    if(candidateNorm === partNorm) return true;
    const minLen = Math.min(candidateNorm.length, partNorm.length);
    if(minLen < Math.min(3, partNorm.length)) return false;
    return candidateNorm.includes(partNorm) || partNorm.includes(candidateNorm);
  }

  function findTextMatchCandidatesInTokens(tokens, query, options = {}){
    const rankerEngine = options.rankerEngine || defaultRankerEngine;
    const groupIntoLines = options.groupIntoLines;
    const bboxOfTokens = options.bboxOfTokens;
    if(typeof groupIntoLines !== 'function' || typeof bboxOfTokens !== 'function') return [];

    const parts = rankerEngine?.getQueryParts ? rankerEngine.getQueryParts(query) : [];
    if(!parts.length) return [];
    const partNorms = parts.map(part => rankerEngine.normalizeMatchToken(part)).filter(Boolean);
    if(!partNorms.length) return [];
    const querySquashed = partNorms.join('');

    const lines = groupIntoLines(tokens || []);
    const matches = [];
    const seen = new Set();
    let order = 0;

    const pushCandidate = (candTokens) => {
      if(!candTokens.length) return;
      const box = bboxOfTokens(candTokens);
      if(!box) return;
      const key = `${Math.round(box.x || 0)}:${Math.round(box.y || 0)}:${Math.round(box.w || 0)}:${Math.round(box.h || 0)}:${box.page || 0}`;
      if(seen.has(key)) return;
      seen.add(key);
      matches.push({
        box,
        tokens: candTokens,
        order: order++,
        score: rankerEngine?.scoreFindTextCandidate
          ? rankerEngine.scoreFindTextCandidate(candTokens, partNorms, querySquashed)
          : 0
      });
    };

    for(const line of lines){
      const lineTokens = line.tokens || [];
      if(!lineTokens.length) continue;
      const tokenNorms = lineTokens.map(t => rankerEngine.normalizeMatchToken(t.text || t.raw || ''));

      if(querySquashed && parts.length > 1){
        tokenNorms.forEach((norm, idx) => {
          if(norm && (norm.includes(querySquashed) || querySquashed.includes(norm))){
            pushCandidate([lineTokens[idx]]);
          }
        });
      }

      for(let i=0; i<=tokenNorms.length - partNorms.length; i++){
        let ok = true;
        for(let j=0; j<partNorms.length; j++){
          if(!isFindTextTokenMatch(tokenNorms[i+j] || '', partNorms[j])){
            ok = false;
            break;
          }
        }
        if(ok){
          pushCandidate(lineTokens.slice(i, i + partNorms.length));
        }
      }
    }

    return matches;
  }

  function findTextMatchInTokens(tokens, query, options = {}){
    const { mode = 'first', rankerContext = null, rankerEngine = defaultRankerEngine, learnedRanker = null } = options || {};
    const candidates = findTextMatchCandidatesInTokens(tokens, query, options);
    if(!candidates.length) return null;
    if(mode === 'best'){
      const ranked = rankerEngine.rankFindTextCandidates(candidates, {
        mode,
        query,
        source: rankerContext?.source || '',
        useRanker: !!rankerContext?.useRanker,
        weights: rankerContext?.weights || null,
        learnedRanker
      });
      return ranked.chosen?.box || null;
    }
    candidates.sort((a,b)=> a.order - b.order);
    return candidates[0].box;
  }

  function findTextMatchesInTokens(tokens, query, options = {}){
    return findTextMatchCandidatesInTokens(tokens, query, options).map(entry => entry.box);
  }

  return {
    normalizeFindTextInput,
    isFindTextTokenMatch,
    findTextMatchCandidatesInTokens,
    findTextMatchInTokens,
    findTextMatchesInTokens
  };
});
