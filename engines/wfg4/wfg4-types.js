(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WFG4Types = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const WFG4_SCHEMA_VERSION = 'wfg4/v0-phase3-structural';
  const WFG4_NORMALIZATION_VERSION = 'wfg4-canonical-working-v1';

  const DEFAULTS = {
    localNeighborhoodScale: 2.2,
    searchWindowPadRatio: 0.35,
    searchWindowMinPadPx: 40,
    maxOrbFeatures: 300,
    ratioTest: 0.78,
    minGoodMatchesForHomography: 10,
    minGoodMatchesForAffine: 6,
    minInliersHomography: 8,
    minInliersAffine: 5,
    minInlierRatio: 0.35,
    refinePadRatio: 0.3,
    refineMinPadPx: 20,
    minTemplateScore: 0.42,
    // structural anchoring defaults (Phase 3 extension)
    structuralExpandRatio: 0.5,
    cannyThreshold1: 50,
    cannyThreshold2: 150,
    houghLineThreshold: 40,
    houghMinLineLength: 30,
    houghMaxLineGap: 10,
    contourMinArea: 200,
    containerOverlapThreshold: 0.7,
    anchorMaxSearchDist: 80,
    structuralSnapMaxPx: 8,
    structuralWeightWhenOrbWeak: 0.6,
    orbWeakConfidenceThreshold: 0.4,
    // Stabilization (P1/P2): hard localization gate + bounded retries
    allowDegradedFallback: false,
    maxLocalizationAttemptsPerField: 4,
    maxLocalizationMsPerField: 2500,
    widenedSearchWindowMultiplier: 2.0,
    globalScanTopCandidates: 3,
    // Readout box floor: avoid over-shrinking runtime localization below
    // the configured bbox footprint. This keeps OCR coverage anchored to
    // what the user selected, while still allowing moderate adaptation.
    readoutMinSideRatio: 0.92
  };

  const LOCALIZATION_STATUS = {
    SUCCESS: 'success',
    FAILED: 'failed',
    DEGRADED_FALLBACK: 'degraded_fallback'
  };

  const BBOX_SOURCE = {
    LOCALIZED_PROJECTED: 'localized_projected',
    LOCALIZED_REFINED: 'localized_refined',
    PREDICTED_FALLBACK: 'predicted_fallback',
    STRUCTURAL_FALLBACK: 'structural_fallback',
    STRUCTURAL_RECONSTRUCTED: 'structural_reconstructed',
    STRUCTURAL_LOCK_PROJECTED: 'structural_lock_projected',
    LITERAL_USER_BOX: 'literal_user_box',
    LEGACY_BOX: 'legacy_box'
  };

  function clamp(value, min, max){
    return Math.max(min, Math.min(max, value));
  }

  function normalizeBox(box){
    if(!box) return null;
    const x = Number(box.x || 0);
    const y = Number(box.y || 0);
    const w = Math.max(1, Number(box.w || 0));
    const h = Math.max(1, Number(box.h || 0));
    return { x, y, w, h, page: box.page || 1 };
  }

  function expandBox(box, pad, bounds){
    const b = normalizeBox(box);
    if(!b) return null;
    const x0 = b.x - pad;
    const y0 = b.y - pad;
    const x1 = b.x + b.w + pad;
    const y1 = b.y + b.h + pad;
    if(!bounds) return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), page: b.page };
    const bx0 = clamp(x0, 0, Math.max(0, bounds.width - 1));
    const by0 = clamp(y0, 0, Math.max(0, bounds.height - 1));
    const bx1 = clamp(x1, bx0 + 1, Math.max(1, bounds.width));
    const by1 = clamp(y1, by0 + 1, Math.max(1, bounds.height));
    return { x: bx0, y: by0, w: Math.max(1, bx1 - bx0), h: Math.max(1, by1 - by0), page: b.page };
  }

  function boxToCorners(box){
    const b = normalizeBox(box);
    if(!b) return [];
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h }
    ];
  }

  function cornersToBox(points, page){
    if(!Array.isArray(points) || !points.length) return null;
    const xs = points.map(p => Number(p.x || 0));
    const ys = points.map(p => Number(p.y || 0));
    const x0 = Math.min.apply(null, xs);
    const y0 = Math.min.apply(null, ys);
    const x1 = Math.max.apply(null, xs);
    const y1 = Math.max.apply(null, ys);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), page: page || 1 };
  }

  return {
    WFG4_SCHEMA_VERSION,
    WFG4_NORMALIZATION_VERSION,
    DEFAULTS,
    clamp,
    normalizeBox,
    expandBox,
    boxToCorners,
    cornersToBox
  };
});
