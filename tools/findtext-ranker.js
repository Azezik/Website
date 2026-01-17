(function(global){
  const LOG_STORAGE_KEY = 'findtext_learning_log_v1';
  const WEIGHTS_STORAGE_KEY = 'findtext_ranker_weights_v1';
  const SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const MAX_LOG_EVENTS = 5000;

  const safeParse = (raw, fallback) => {
    if(!raw) return fallback;
    try{
      return JSON.parse(raw);
    } catch(err){
      return fallback;
    }
  };

  const normalizeMatchText = (text) => {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const normalizeMatchToken = (text) => normalizeMatchText(text).replace(/\s+/g, '');

  const getQueryParts = (query) => {
    const normalized = normalizeMatchText(query);
    return normalized ? normalized.split(' ').filter(Boolean) : [];
  };

  const looksLikeEmail = (text) => /@/.test(text);
  const looksLikeUrl = (text) => /\bhttps?:\/\/|www\./i.test(text);
  const isNumericOnly = (text) => /^[\d.,-]+$/.test(String(text || '').trim());
  const isMixedAlnum = (text) => /[\d]/.test(text) && /[a-z]/i.test(text);

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
      if(norm === part){
        exactMatchCount += 1;
      } else if(norm.startsWith(part)){
        startsWithCount += 1;
      } else if(norm.includes(part) || part.includes(norm)){
        substringCount += 1;
      }
    });

    const confidenceVals = tokens
      .map(t => Number.isFinite(t.confidence) ? t.confidence : null)
      .filter(v => Number.isFinite(v));
    const avgConf = confidenceVals.length
      ? confidenceVals.reduce((sum, v) => sum + v, 0) / confidenceVals.length
      : null;
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
    if(!weights || typeof weights !== 'object'){
      return fallbackScore;
    }
    const bias = Number.isFinite(weights.bias) ? weights.bias : 0;
    let score = bias;
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
      return {
        ...candidate,
        _ranker: {
          index: idx,
          features,
          learnedScore,
          fallbackScore
        }
      };
    });
    ranked.sort((a,b)=> {
      if(b._ranker.learnedScore !== a._ranker.learnedScore){
        return b._ranker.learnedScore - a._ranker.learnedScore;
      }
      return a.order - b.order;
    });
    return ranked;
  }

  function buildCandidateId(candidate, index){
    const box = candidate?.box || {};
    const key = [
      Math.round(box.x || 0),
      Math.round(box.y || 0),
      Math.round(box.w || 0),
      Math.round(box.h || 0),
      box.page || 0
    ].join(':');
    return `cand_${index}_${key}`;
  }

  const logState = {
    sessionId: SESSION_ID,
    events: []
  };

  function loadLogFromStorage(){
    if(typeof localStorage === 'undefined') return;
    const stored = safeParse(localStorage.getItem(LOG_STORAGE_KEY), null);
    if(stored && Array.isArray(stored.events)){
      logState.events = stored.events.slice();
    }
  }

  function persistLog(){
    if(typeof localStorage === 'undefined') return;
    const payload = { sessionId: logState.sessionId, events: logState.events.slice(-MAX_LOG_EVENTS) };
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(payload));
  }

  function appendLogEvent(event){
    logState.events.push(event);
    if(logState.events.length > MAX_LOG_EVENTS){
      logState.events = logState.events.slice(-MAX_LOG_EVENTS);
    }
    persistLog();
  }

  function clearLog(){
    logState.events = [];
    persistLog();
  }

  function downloadLog(){
    const lines = logState.events.map(entry => JSON.stringify(entry));
    const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `findtext-learning-log-${ts}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function loadWeightsFromStorage(){
    if(typeof localStorage === 'undefined') return null;
    return safeParse(localStorage.getItem(WEIGHTS_STORAGE_KEY), null);
  }

  function storeWeights(weights){
    if(typeof localStorage === 'undefined') return;
    localStorage.setItem(WEIGHTS_STORAGE_KEY, JSON.stringify(weights || {}));
  }

  loadLogFromStorage();

  const api = {
    extractFeatures,
    scoreCandidate,
    rankCandidates,
    buildCandidateId,
    appendLogEvent,
    clearLog,
    downloadLog,
    loadWeightsFromStorage,
    storeWeights,
    logState
  };

  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.FindTextRanker = api;
})(typeof window !== 'undefined' ? window : globalThis);
