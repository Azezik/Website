(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RunLandmarkOnce = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  function clamp01(v){
    return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  function matchRingLandmarkOnce(fieldConfig, pageTokens, opts = {}){
    if(!fieldConfig || !fieldConfig.landmark) return null;
    const { resolveBox, captureFn, compareFn, baseBoxPx } = opts;
    const boxPx = baseBoxPx || (typeof resolveBox === 'function' ? resolveBox(fieldConfig, pageTokens) : null);
    if(!boxPx || typeof captureFn !== 'function' || typeof compareFn !== 'function') return null;
    const sample = captureFn(boxPx);
    if(!sample) return null;
    const { score } = compareFn(sample, fieldConfig.landmark) || {};
    if(!Number.isFinite(score)) return null;
    return clamp01(score);
  }

  function maybeBoostWithLandmark({ fieldConfig, pageTokens, baseConfidence = 0, baseBoxPx = null, captureFn, compareFn, resolveBox, low = 0.3, high = 0.8 }){
    const boundedBase = clamp01(baseConfidence);
    if(!fieldConfig || !fieldConfig.landmark) return { confidence: boundedBase, landmarkScore: null, attempted: false };
    if(!(boundedBase > low && boundedBase < high)){
      return { confidence: boundedBase, landmarkScore: null, attempted: false };
    }
    const landmarkScore = matchRingLandmarkOnce(fieldConfig, pageTokens, { captureFn, compareFn, resolveBox, baseBoxPx });
    if(!Number.isFinite(landmarkScore)){
      return { confidence: boundedBase, landmarkScore: null, attempted: true };
    }
    return { confidence: Math.max(boundedBase, landmarkScore), landmarkScore, attempted: true };
  }

  return { matchRingLandmarkOnce, maybeBoostWithLandmark };
});
