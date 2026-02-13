(function(global){
  const engine = global.EngineFindTextConstellation
    || (typeof require !== 'undefined' ? require('../engines/findtext/constellation-engine.js') : null);

  const normalizeKeywordText = (global.KeywordWeighting?.normalizeKeywordText)
    || (typeof require !== 'undefined' ? require('./keyword-weighting.js').normalizeKeywordText : null);

  if(!engine){
    global.KeywordConstellation = global.KeywordConstellation || null;
    return;
  }

  function captureConstellation(fieldKey, boxPx, normBox, page, pageW, pageH, tokens, opts = {}){
    return engine.captureConstellation(fieldKey, boxPx, normBox, page, pageW, pageH, tokens, {
      ...opts,
      normalizeKeywordText: opts.normalizeKeywordText || normalizeKeywordText
    });
  }

  function matchConstellation(constellation, tokens, opts = {}){
    return engine.matchConstellation(constellation, tokens, {
      ...opts,
      normalizeKeywordText: opts.normalizeKeywordText || normalizeKeywordText
    });
  }

  const api = {
    BASE_RADIUS: engine.BASE_RADIUS,
    EXPANDED_RADIUS: engine.EXPANDED_RADIUS,
    DEFAULT_TOLERANCE: engine.DEFAULT_TOLERANCE,
    captureConstellation,
    matchConstellation,
    scoreEdgeMatch: engine.scoreEdgeMatch,
    delta: engine.delta,
    centerNorm: engine.centerNorm,
    normalizeBoxPx: engine.normalizeBoxPx
  };

  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.KeywordConstellation = api;
})(typeof window !== 'undefined' ? window : globalThis);
