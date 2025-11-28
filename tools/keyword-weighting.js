(function(global){
  const MAX_KEYWORD_RADIUS = 0.35;

  function clamp(val, min, max){ return Math.min(max, Math.max(min, val)); }

  function normalizeKeywordText(text){
    return (text || '')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function editDistance(a,b){
    const dp = Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
    for(let i=0;i<=a.length;i++) dp[i][0]=i;
    for(let j=0;j<=b.length;j++) dp[0][j]=j;
    for(let i=1;i<=a.length;i++){
      for(let j=1;j<=b.length;j++){
        dp[i][j] = a[i-1]===b[j-1]
          ? dp[i-1][j-1]
          : Math.min(dp[i-1][j-1], dp[i][j-1], dp[i-1][j]) + 1;
      }
    }
    return dp[a.length][b.length];
  }

  function toNormalizedBox(entry, pageW, pageH){
    if(entry?.bboxNorm){ return entry.bboxNorm; }
    if(entry?.bboxPx){
      return {
        x: (entry.bboxPx.x || 0) / pageW,
        y: (entry.bboxPx.y || 0) / pageH,
        w: (entry.bboxPx.w || 0) / pageW,
        h: (entry.bboxPx.h || 0) / pageH
      };
    }
    return { x:0, y:0, w:0, h:0 };
  }

  function predictBoxFromKeyword(entry, relation, pageW, pageH){
    if(!entry || !relation) return null;
    const norm = toNormalizedBox(entry, pageW, pageH);
    const predictedNorm = {
      x: (norm.x || 0) + (relation.offset?.dx || 0),
      y: (norm.y || 0) + (relation.offset?.dy || 0),
      w: Math.max(0, (norm.w || 0) + (relation.offset?.dw || 0)),
      h: Math.max(0, (norm.h || 0) + (relation.offset?.dh || 0))
    };
    return {
      x: predictedNorm.x * pageW,
      y: predictedNorm.y * pageH,
      w: predictedNorm.w * pageW,
      h: predictedNorm.h * pageH,
      page: entry.page || 1,
      norm: predictedNorm
    };
  }

  function scoreTextSimilarity(target, candidate){
    const normTarget = normalizeKeywordText(target);
    const normCandidate = normalizeKeywordText(candidate);
    if(!normTarget || !normCandidate) return 0;
    const dist = editDistance(normTarget, normCandidate);
    const maxLen = Math.max(1, Math.max(normTarget.length, normCandidate.length));
    return 1 - Math.min(1, dist / maxLen);
  }

  function chooseKeywordMatch(relation, keywordIndex, referenceBox, pageW, pageH){
    if(!relation || !Array.isArray(keywordIndex) || !keywordIndex.length) return null;
    const candidates = keywordIndex.filter(k => k && k.category === relation.category);
    if(!candidates.length) return null;
    const refCx = referenceBox ? referenceBox.x + (referenceBox.w||0)/2 : null;
    const refCy = referenceBox ? referenceBox.y + (referenceBox.h||0)/2 : null;
    let best = null;
    for(const entry of candidates){
      const predictedBox = predictBoxFromKeyword(entry, relation, pageW, pageH);
      if(!predictedBox) continue;
      const pcx = predictedBox.x + (predictedBox.w||0)/2;
      const pcy = predictedBox.y + (predictedBox.h||0)/2;
      const dist = (refCx === null || refCy === null)
        ? 0
        : Math.hypot((pcx - refCx) / pageW, (pcy - refCy) / pageH);
      if(dist > MAX_KEYWORD_RADIUS) continue;
      const textScore = scoreTextSimilarity(relation.text || '', entry.keyword || '');
      const sizePenalty = Math.abs((predictedBox.w||1) - (referenceBox?.w||predictedBox.w||1)) / Math.max(1, referenceBox?.w || predictedBox.w || 1);
      const score = (1 - Math.min(1, dist / MAX_KEYWORD_RADIUS)) * 0.7 + textScore * 0.25 + (1 - Math.min(1, sizePenalty)) * 0.05;
      if(!best || score > best.score){
        best = { entry, predictedBox, dist, score };
      }
    }
    return best;
  }

  function computeKeywordWeight(candidateBox, predictedBox, opts={}){
    const { strongAnchor=false, maxRadius=MAX_KEYWORD_RADIUS } = opts;
    if(!candidateBox || !predictedBox) return 1;
    const pageW = opts.pageW || 1;
    const pageH = opts.pageH || 1;
    const cCx = candidateBox.x + (candidateBox.w||0)/2;
    const cCy = candidateBox.y + (candidateBox.h||0)/2;
    const pCx = predictedBox.x + (predictedBox.w||0)/2;
    const pCy = predictedBox.y + (predictedBox.h||0)/2;
    const dist = Math.hypot((pCx - cCx)/pageW, (pCy - cCy)/pageH);
    if(dist > maxRadius){ return 1; }
    const proximity = Math.max(0, 1 - (dist / maxRadius));
    const sizeRatioW = Math.min(candidateBox.w || 1, predictedBox.w || 1) / Math.max(candidateBox.w || 1, predictedBox.w || 1);
    const sizeRatioH = Math.min(candidateBox.h || 1, predictedBox.h || 1) / Math.max(candidateBox.h || 1, predictedBox.h || 1);
    const sizeScore = (sizeRatioW + sizeRatioH) / 2;
    const composite = (proximity * 0.6) + (sizeScore * 0.4);
    let weight = 1 + (composite - 0.5) * 0.4;
    weight = clamp(weight, 0.8, strongAnchor ? Math.min(1.05, weight) : 1.2);
    return weight;
  }

  function triangulateBox(relations, keywordIndex, pageW, pageH, referenceBox, opts={}){
    if(!relations) return null;
    const configWeight = Number.isFinite(opts.configWeight) ? opts.configWeight : 0.6;
    const seeds = [];
    const seed = (pred, source, weight=1, entry=null)=>{
      if(!pred) return;
      seeds.push({ box: pred, source, weight, entry });
    };

    const motherPred = chooseKeywordMatch(relations.mother, keywordIndex, referenceBox, pageW, pageH);
    if(motherPred?.predictedBox){ seed(motherPred.predictedBox, 'mother', 1.1, motherPred.entry || relations.mother); }

    const secondaryMatches = [];
    for(const rel of (relations.secondaries || [])){
      const pred = chooseKeywordMatch(rel, keywordIndex, referenceBox, pageW, pageH);
      if(pred?.predictedBox){
        secondaryMatches.push(pred);
        seed(pred.predictedBox, 'secondary', 0.9, pred.entry || rel);
      }
    }

    if(referenceBox){
      seed(referenceBox, 'config', configWeight, null);
    }

    if(!seeds.length) return null;

    const totals = seeds.reduce((acc, { box, weight })=>{
      const w = weight || 1;
      acc.weight += w;
      acc.cx += (box.x + (box.w||0)/2) * w;
      acc.cy += (box.y + (box.h||0)/2) * w;
      acc.w += (box.w || 0) * w;
      acc.h += (box.h || 0) * w;
      if(acc.page === null && box.page){ acc.page = box.page; }
      return acc;
    }, { cx:0, cy:0, w:0, h:0, weight:0, page: null });

    const weight = totals.weight || 1;
    const cx = totals.cx / weight;
    const cy = totals.cy / weight;
    const w = Math.max(4, totals.w / weight);
    const h = Math.max(4, totals.h / weight);
    const box = { x: cx - w/2, y: cy - h/2, w, h, page: totals.page || referenceBox?.page || 1 };
    return { box, seeds, motherPred, secondaryMatches };
  }

  const api = {
    MAX_KEYWORD_RADIUS,
    normalizeKeywordText,
    chooseKeywordMatch,
    computeKeywordWeight,
    triangulateBox,
    predictBoxFromKeyword
  };

  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.KeywordWeighting = api;
})(typeof window !== 'undefined' ? window : globalThis);
