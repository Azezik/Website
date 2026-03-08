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

  // ── Scale / rotation transform (used when the user applies a scale or rotation) ──

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

  // ── Canonical document page-space ─────────────────────────────────────────────
  //
  // All pipeline stages (OCR tokens, text graph, feature graph, extraction boxes,
  // overlay rendering) should express geometry in a SINGLE coordinate system:
  //   • "viewport pixel space"  — pixel coordinates relative to the top-left of
  //     the rendered page at the current scale.  This matches the coordinate space
  //     used by stored normBoxes after denormalisation:
  //         px = normValue * vpDimension
  //
  // A "content bounds" rectangle (in viewport pixel space) marks the area where
  // actual document content resides.  For most PDFs this is the full viewport;
  // for scanned images it may be smaller (trimmed borders, etc.).
  //
  // normalizeToPageSpace  → converts a pixel box into [0,1] page-space relative
  //                         to the content bounds.
  // denormalizeFromPageSpace → inverse.
  // detectDocumentBounds → infers content bounds from OCR token extents.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Detect the bounding rectangle of document content from OCR tokens.
   * Returns content bounds in viewport pixel space: { x, y, w, h }.
   * Falls back to the full viewport when no tokens are available.
   *
   * @param {Array}  tokens   – array of {x, y, w, h} in viewport pixel space
   * @param {Object} viewport – { width, height } viewport dimensions
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function detectDocumentBounds(tokens, viewport){
    const { width: vpW, height: vpH } = getViewportDimensions(viewport);
    const fullBounds = { x: 0, y: 0, w: vpW, h: vpH };

    if(!Array.isArray(tokens) || !tokens.length) return fullBounds;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(const tok of tokens){
      const tx = Number.isFinite(tok?.x) ? tok.x : null;
      const ty = Number.isFinite(tok?.y) ? tok.y : null;
      const tw = Number.isFinite(tok?.w) ? tok.w : 0;
      const th = Number.isFinite(tok?.h) ? tok.h : 0;
      if(tx === null || ty === null) continue;
      x0 = Math.min(x0, tx);
      y0 = Math.min(y0, ty);
      x1 = Math.max(x1, tx + tw);
      y1 = Math.max(y1, ty + th);
    }

    if(!Number.isFinite(x0) || !Number.isFinite(y0)) return fullBounds;

    // Clamp to viewport and add a small margin so the outermost tokens are fully
    // inside the content bounds.
    const margin = Math.max(2, vpW * 0.005);
    return {
      x: Math.max(0, x0 - margin),
      y: Math.max(0, y0 - margin),
      w: Math.min(vpW, x1 + margin) - Math.max(0, x0 - margin),
      h: Math.min(vpH, y1 + margin) - Math.max(0, y0 - margin)
    };
  }

  /**
   * Normalise a viewport-pixel box to [0,1] page-space, relative to the given
   * content bounds (defaulting to the full viewport).
   *
   * This is the canonical normalisation path used by all pipeline stages.
   *
   * @param {{ x, y, w, h }} box           – pixel box in viewport space
   * @param {Object}          viewport       – { width, height }
   * @param {{ x, y, w, h }} [contentBounds] – optional; defaults to full viewport
   * @returns {{ nx: number, ny: number, nw: number, nh: number,
   *             ncx: number, ncy: number }}
   */
  function normalizeToPageSpace(box, viewport, contentBounds){
    const { width: vpW, height: vpH } = getViewportDimensions(viewport);
    const cb = contentBounds || { x: 0, y: 0, w: vpW, h: vpH };
    const cbW = Math.max(1, cb.w);
    const cbH = Math.max(1, cb.h);
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const nx  = clamp((box.x - cb.x) / cbW);
    const ny  = clamp((box.y - cb.y) / cbH);
    const nw  = clamp(box.w / cbW);
    const nh  = clamp(box.h / cbH);
    return {
      nx,
      ny,
      nw,
      nh,
      ncx: clamp(nx + nw / 2),
      ncy: clamp(ny + nh / 2)
    };
  }

  /**
   * Convert normalised page-space coordinates back to viewport-pixel coordinates.
   *
   * @param {{ nx, ny, nw, nh }} normBox      – normalised [0,1] box
   * @param {Object}              viewport      – { width, height }
   * @param {{ x, y, w, h }}    [contentBounds] – optional; defaults to full viewport
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function denormalizeFromPageSpace(normBox, viewport, contentBounds){
    const { width: vpW, height: vpH } = getViewportDimensions(viewport);
    const cb = contentBounds || { x: 0, y: 0, w: vpW, h: vpH };
    const cbW = Math.max(1, cb.w);
    const cbH = Math.max(1, cb.h);
    return {
      x: cb.x + normBox.nx * cbW,
      y: cb.y + normBox.ny * cbH,
      w: normBox.nw * cbW,
      h: normBox.nh * cbH
    };
  }

  return {
    getViewportDimensions,
    applyTransform,
    detectDocumentBounds,
    normalizeToPageSpace,
    denormalizeFromPageSpace
  };
});
