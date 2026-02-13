(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineStaticRingLandmark = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function edgeScore(sample, tmpl, half = null){
    const mask = tmpl.ringMask;
    const w = tmpl.patchSize;
    let count = 0;
    let sumA = 0;
    let sumB = 0;
    for(let i = 0; i < mask.length; i++){
      if(!mask[i]) continue;
      const x = i % w;
      if(half === 'right' && x < w / 2) continue;
      if(half === 'left' && x >= w / 2) continue;
      sumA += sample.edgePatch[i];
      sumB += tmpl.edgePatch[i];
      count++;
    }
    const meanA = count ? sumA / count : 0;
    const meanB = count ? sumB / count : 0;
    let num = 0;
    let dA = 0;
    let dB = 0;
    let match = 0;
    for(let i = 0; i < mask.length; i++){
      if(!mask[i]) continue;
      const x = i % w;
      if(half === 'right' && x < w / 2) continue;
      if(half === 'left' && x >= w / 2) continue;
      const a = sample.edgePatch[i];
      const b = tmpl.edgePatch[i];
      num += (a - meanA) * (b - meanB);
      dA += (a - meanA) * (a - meanA);
      dB += (b - meanB) * (b - meanB);
      if(a === b) match++;
    }
    if(dA > 0 && dB > 0) return { score: num / Math.sqrt(dA * dB), comparator: 'edge_zncc' };
    return { score: count ? match / count : -1, comparator: 'edge_hamming' };
  }

  function applyLandmarkOffset(matchBox, landmarkOffset, baseBox){
    if(!matchBox || !baseBox) return null;
    const dx = landmarkOffset?.dx || 0;
    const dy = landmarkOffset?.dy || 0;
    return {
      x: matchBox.x + dx * baseBox.w,
      y: matchBox.y + dy * baseBox.h,
      w: baseBox.w,
      h: baseBox.h,
      page: baseBox.page
    };
  }

  function matchRingLandmark(landmark, guessPx, opts = {}){
    const { captureFn, viewport = {}, half = null, range = null, step = 4, threshold = null } = opts;
    if(!landmark || !guessPx || typeof captureFn !== 'function') return null;
    const vpH = ((viewport.h ?? viewport.height) || 1);
    const searchRange = Number.isFinite(range) ? range : (0.25 * vpH);
    const acceptThreshold = Number.isFinite(threshold) ? threshold : (half ? 0.60 : 0.75);
    let best = { score: -1, box: null, comparator: null };
    for(let dy = -searchRange; dy <= searchRange; dy += step){
      for(let dx = -searchRange; dx <= searchRange; dx += step){
        const box = { x: guessPx.x + dx, y: guessPx.y + dy, w: guessPx.w, h: guessPx.h, page: guessPx.page };
        const sample = captureFn(box);
        if(!sample) continue;
        const { score, comparator } = edgeScore(sample, landmark, half);
        if(score > best.score){ best = { score, box, comparator }; }
      }
    }
    if(best.score >= acceptThreshold){
      return { ...best.box, score: best.score, comparator: best.comparator };
    }
    return null;
  }

  return { edgeScore, matchRingLandmark, applyLandmarkOffset };
});
