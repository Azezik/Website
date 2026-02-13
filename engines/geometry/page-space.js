(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EnginePageSpace = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  function getViewportDimensions(viewport){
    const width = Math.max(1, ((viewport?.width ?? viewport?.w) || 0) || 1);
    const height = Math.max(1, ((viewport?.height ?? viewport?.h) || 0) || 1);
    return { width, height };
  }

  function applyTransform(boxPx, transform = {}, viewport = {}){
    const { scale = 1, rotation = 0 } = transform || {};
    if(scale === 1 && rotation === 0) return { ...boxPx };
    const wPage = ((viewport.w ?? viewport.width) || 1);
    const hPage = ((viewport.h ?? viewport.height) || 1);
    const cx = wPage / 2;
    const cy = hPage / 2;
    const x = boxPx.x + boxPx.w / 2;
    const y = boxPx.y + boxPx.h / 2;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const dx = (x - cx) * scale;
    const dy = (y - cy) * scale;
    const x2 = dx * cos - dy * sin + cx;
    const y2 = dx * sin + dy * cos + cy;
    const w = boxPx.w * scale;
    const h = boxPx.h * scale;
    return { x: x2 - w / 2, y: y2 - h / 2, w, h, page: boxPx.page };
  }

  return {
    getViewportDimensions,
    applyTransform
  };
});
