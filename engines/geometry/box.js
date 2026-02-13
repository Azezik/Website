(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineGeometryBox = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const normalizeBox = (boxPx, canvasW, canvasH) => ({
    x0n: boxPx.x / canvasW,
    y0n: boxPx.y / canvasH,
    wN: boxPx.w / canvasW,
    hN: boxPx.h / canvasH
  });

  const denormalizeBox = (normBox, W, H) => ({
    sx: Math.round(normBox.x0n * W),
    sy: Math.round(normBox.y0n * H),
    sw: Math.max(1, Math.round(normBox.wN * W)),
    sh: Math.max(1, Math.round(normBox.hN * H))
  });

  function intersect(a,b){
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  return {
    normalizeBox,
    denormalizeBox,
    intersect
  };
});
