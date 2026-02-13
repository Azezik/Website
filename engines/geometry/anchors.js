(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineGeometryAnchors = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function boxFromAnchor(landmarkPx, anchor, viewportPx){
    if(!landmarkPx || !anchor || !viewportPx) return null;
    const { dx, dy, w, h } = anchor;
    return {
      x: landmarkPx.x + dx * viewportPx.w,
      y: landmarkPx.y + dy * viewportPx.h,
      w: w * viewportPx.w,
      h: h * viewportPx.h,
      page: landmarkPx.page
    };
  }

  return { boxFromAnchor };
});
