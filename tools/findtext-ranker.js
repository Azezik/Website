(function(global){
  const pure = global.EngineFindTextRanker
    || (typeof require !== 'undefined' ? require('../engines/findtext/ranker.js') : null);

  const LOG_STORAGE_KEY = 'findtext_learning_log_v1';
  const WEIGHTS_STORAGE_KEY = 'findtext_ranker_weights_v1';
  const SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const MAX_LOG_EVENTS = 5000;

  const safeParse = (raw, fallback) => {
    if(!raw) return fallback;
    try{ return JSON.parse(raw); } catch(err){ return fallback; }
  };

  const normalizeMatchText = pure?.normalizeMatchText || ((text) => String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());

  const normalizeMatchToken = pure?.normalizeMatchToken || ((text) => normalizeMatchText(text).replace(/\s+/g, ''));

  const extractFeatures = pure?.extractFeatures || (() => ({}));
  const scoreCandidate = pure?.scoreCandidate || ((features, weights, fallbackScore = 0) => fallbackScore);
  const rankCandidates = pure?.rankCandidates || ((candidates) => (candidates || []).slice());

  function buildCandidateId(candidate, index){
    const box = candidate?.box || {};
    const key = [
      Math.round(box.x || 0), Math.round(box.y || 0), Math.round(box.w || 0), Math.round(box.h || 0), box.page || 0
    ].join(':');
    return `cand_${index}_${key}`;
  }

  const logState = { sessionId: SESSION_ID, events: [] };

  function loadLogFromStorage(){
    if(typeof localStorage === 'undefined') return;
    const stored = safeParse(localStorage.getItem(LOG_STORAGE_KEY), null);
    if(stored && Array.isArray(stored.events)) logState.events = stored.events.slice();
  }
  function persistLog(){
    if(typeof localStorage === 'undefined') return;
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify({ sessionId: logState.sessionId, events: logState.events.slice(-MAX_LOG_EVENTS) }));
  }
  function appendLogEvent(event){
    logState.events.push(event);
    if(logState.events.length > MAX_LOG_EVENTS) logState.events = logState.events.slice(-MAX_LOG_EVENTS);
    persistLog();
  }
  function clearLog(){ logState.events = []; persistLog(); }

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
    normalizeMatchText,
    normalizeMatchToken,
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

  if(typeof module !== 'undefined' && module.exports){ module.exports = api; }
  global.FindTextRanker = api;
})(typeof window !== 'undefined' ? window : globalThis);
