(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineStaticScoring = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function scoreDistance(opts = {}){
    const {
      candidateCenter,
      triCenter,
      baseCenter = null,
      pageW = 1,
      pageH = 1,
      maxRadius = 0.35,
      farFromHint = false
    } = opts;
    if(!candidateCenter || !triCenter || !pageW || !pageH || !maxRadius) return 0;
    const distNorm = Math.hypot((candidateCenter.x - triCenter.x) / pageW, (candidateCenter.y - triCenter.y) / pageH);
    const baseDistNorm = (!baseCenter || baseCenter.x === null || baseCenter.y === null)
      ? null
      : Math.hypot((candidateCenter.x - baseCenter.x) / pageW, (candidateCenter.y - baseCenter.y) / pageH);
    const baseBias = baseDistNorm === null
      ? 1
      : Math.max(0.65, 1 - Math.min(1, baseDistNorm / maxRadius));
    const hintPenalty = farFromHint ? 0.6 : 1;
    return Math.max(0, 1 - (distNorm / maxRadius)) * baseBias * hintPenalty;
  }

  function scoreTotal(opts = {}){
    const {
      baseConf = 0,
      keywordScore = 1,
      distanceScore = 0,
      anchorScore = 1,
      fpScore = 1,
      lineScore = 1
    } = opts;
    return clamp(baseConf * keywordScore * (0.55 + distanceScore * 0.45) * anchorScore * fpScore * lineScore, 0, 2);
  }

  function scoreConfidence(opts = {}){
    const {
      cleanedConf = 0.6,
      fingerprintOk = false,
      anchorOk = false,
      anchorSoftOk = false,
      distanceScore = 0
    } = opts;
    return clamp((cleanedConf || 0.6)
      * (fingerprintOk ? 1 : 0.75)
      * (anchorOk ? 1 : anchorSoftOk ? 0.85 : 0.75)
      * (0.55 + distanceScore * 0.45), 0, 1);
  }

  function applyFieldBias(candidate, opts = {}){
    if(!candidate) return candidate;
    const {
      isCustomerNameField = false,
      isCustomerAddressField = false
    } = opts;
    const text = (candidate.cleaned?.value || candidate.text || '').toUpperCase();
    const hasDigit = /\d/.test(text);
    const hasPostal = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(text) || /\b\d{5}(?:-\d{4})?\b/.test(text);
    const hasStreet = /\b(?:STREET|ST\.?|RD\.?|ROAD|AVE|AVENUE|BLVD|DR\.?|DRIVE|WAY|LANE|LN\.?|CRES|COURT|CT\.?|TRL|TRAIL)\b/i.test(text);
    const hasPhone = /\b\(?\d{3}\)?[\s./-]?\d{3}[\s./-]?\d{4}\b/.test(text);

    if(isCustomerNameField){
      const addressLike = hasDigit || hasPostal || hasStreet || hasPhone;
      const nameLike = /[A-Z]{3,}\s+[A-Z]{3,}(?:\s+[A-Z]{2,})?/.test(text);
      if(addressLike){
        candidate.totalScore = clamp(candidate.totalScore * 0.6, 0, 2);
        candidate.confidence = clamp(candidate.confidence * 0.65, 0, 1);
      }
      if(nameLike && !addressLike){
        candidate.totalScore = clamp(candidate.totalScore * 1.15, 0, 2);
        candidate.confidence = clamp(candidate.confidence * 1.1, 0, 1);
      }
    } else if(isCustomerAddressField){
      const addressStrong = hasPostal || (hasDigit && hasStreet);
      const phoneOnly = hasPhone && !hasStreet && !hasPostal;
      if(addressStrong){
        candidate.totalScore = clamp(candidate.totalScore * 1.15, 0, 2);
        candidate.confidence = clamp(candidate.confidence * 1.1, 0, 1);
      }
      if(phoneOnly){
        candidate.totalScore = clamp(candidate.totalScore * 0.6, 0, 2);
        candidate.confidence = clamp(candidate.confidence * 0.65, 0, 1);
      }
    }
    return candidate;
  }

  function rankCandidates(candidates, opts = {}){
    const {
      staticRun = false,
      maxStaticCandidates = 0,
      currentCandidate = null,
      minStaticAcceptScore = 0
    } = opts;
    if(!Array.isArray(candidates) || !candidates.length) return null;

    let sorted = candidates.slice().sort((a,b)=> b.totalScore - a.totalScore);
    if(staticRun && maxStaticCandidates > 0 && sorted.length > maxStaticCandidates){
      sorted = sorted.slice(0, maxStaticCandidates);
      if(currentCandidate && !sorted.includes(currentCandidate)){
        sorted.push(currentCandidate);
        sorted = sorted.sort((a,b)=> b.totalScore - a.totalScore);
      }
    }

    const best = sorted[0] || null;
    const currentScore = currentCandidate?.totalScore ?? 0;
    let preferBest = !!(best && best !== currentCandidate && (
      best.totalScore > (currentScore || 0) * 1.05
      || (!currentCandidate?.fpOk && best.fpOk && best.distanceScore > (currentCandidate?.distanceScore || 0))
    ));

    if(staticRun && best){
      const lineOk = (best.lineDiff ?? Infinity) <= 1 || best.fpOk;
      if(best.totalScore < minStaticAcceptScore || !lineOk){
        preferBest = false;
      }
    }

    return { candidates: sorted, best, current: currentCandidate, preferBest };
  }

  return {
    scoreDistance,
    scoreTotal,
    scoreConfidence,
    applyFieldBias,
    rankCandidates
  };
});
