/*
 * WFG4 CaptureFrame — single source of truth for config-time geometry.
 *
 * See dev-logs/wfg4-capture-frame-progress.md §3. A CaptureFrame is the
 * unifying object that eliminates coordinate-space ambiguity between display
 * viewport space, working surface space, and the overlay/display canvas rect.
 *
 * Built once when the user confirms a box. Every downstream consumer (engine,
 * OCR crop, debug overlay) dereferences this one object instead of re-reading
 * state.pageViewports / state.viewport / els.pdfCanvas independently.
 */
(function(global){
  'use strict';

  function pickVp(state, idx){
    const vp = state?.pageViewports?.[idx] || state?.viewport || null;
    if(!vp) return null;
    const w = Number(vp.width ?? vp.w);
    const h = Number(vp.height ?? vp.h);
    if(!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: Math.round(w), height: Math.round(h) };
  }

  function invariantsReport({ pageNum, state }){
    const idx = Math.max(0, (Number(pageNum) || 1) - 1);
    const surface = state?.wfg4?.configSurface || null;
    const pageEntry = surface?.pages?.[idx] || null;
    const reasons = [];
    if(!surface || !Array.isArray(surface.pages) || !surface.pages.length) reasons.push('config_surface_missing');
    if(!pageEntry) reasons.push('page_entry_missing');
    const working = pageEntry?.dimensions?.working || null;
    if(!working || !(working.width > 0) || !(working.height > 0)) reasons.push('working_dims_missing');
    if(!pageEntry?.artifacts?.displayDataUrl) reasons.push('display_data_url_missing');
    if(!pageEntry?.pageStructure) reasons.push('page_structure_missing');
    return { pageEntry, reasons };
  }

  function buildCaptureFrame({ pageNum, userBoxDisplayPx, state }){
    const idx = Math.max(0, (Number(pageNum) || 1) - 1);
    const { pageEntry, reasons } = invariantsReport({ pageNum, state });
    if(!pageEntry || !pageEntry.dimensions?.working || !pageEntry.artifacts?.displayDataUrl){
      return { ok: false, reasons, frame: null };
    }
    const working = pageEntry.dimensions.working;
    const workingW = Math.max(1, Math.round(working.width));
    const workingH = Math.max(1, Math.round(working.height));
    const vp = pickVp(state, idx) || { width: workingW, height: workingH };
    const displayW = vp.width;
    const displayH = vp.height;
    const sX = workingW / displayW;
    const sY = workingH / displayH;

    const ubd = userBoxDisplayPx || {};
    const userBoxDisplay = Object.freeze({
      x: Number(ubd.x) || 0,
      y: Number(ubd.y) || 0,
      w: Number(ubd.w) || 0,
      h: Number(ubd.h) || 0,
      page: Number(pageNum) || 1
    });
    const userBoxWorking = Object.freeze({
      x: userBoxDisplay.x * sX,
      y: userBoxDisplay.y * sY,
      w: userBoxDisplay.w * sX,
      h: userBoxDisplay.h * sY,
      page: userBoxDisplay.page
    });
    const userBoxNorm = Object.freeze({
      x0n: workingW > 0 ? userBoxWorking.x / workingW : 0,
      y0n: workingH > 0 ? userBoxWorking.y / workingH : 0,
      wN:  workingW > 0 ? userBoxWorking.w / workingW : 0,
      hN:  workingH > 0 ? userBoxWorking.h / workingH : 0
    });

    const frame = {
      pageNum: userBoxDisplay.page,
      sourceType: state?.isImage
        ? 'image'
        : ((Array.isArray(state?.tokensByPage?.[userBoxDisplay.page]) && state.tokensByPage[userBoxDisplay.page].length)
            ? 'pdf-text-layer'
            : 'pdf-scanned-or-empty'),
      generation: Number(pageEntry.generation || 0),
      display: Object.freeze({ width: displayW, height: displayH }),
      working: Object.freeze({ width: workingW, height: workingH }),
      scale: Object.freeze({ workingFromDisplayX: sX, workingFromDisplayY: sY }),
      workingImageDataUrl: pageEntry.artifacts.displayDataUrl,
      pageEntryRef: pageEntry,
      userBoxDisplayPx: userBoxDisplay,
      userBoxWorkingPx: userBoxWorking,
      userBoxNorm,
      toWorking(boxInDisplay){
        if(!boxInDisplay) return null;
        return {
          x: (Number(boxInDisplay.x) || 0) * sX,
          y: (Number(boxInDisplay.y) || 0) * sY,
          w: (Number(boxInDisplay.w) || 0) * sX,
          h: (Number(boxInDisplay.h) || 0) * sY,
          page: userBoxDisplay.page
        };
      },
      toDisplay(boxInWorking){
        if(!boxInWorking || !sX || !sY) return null;
        return {
          x: (Number(boxInWorking.x) || 0) / sX,
          y: (Number(boxInWorking.y) || 0) / sY,
          w: (Number(boxInWorking.w) || 0) / sX,
          h: (Number(boxInWorking.h) || 0) / sY,
          page: userBoxDisplay.page
        };
      },
      toNormalized(boxInWorking){
        if(!boxInWorking) return null;
        return {
          x0n: (Number(boxInWorking.x) || 0) / workingW,
          y0n: (Number(boxInWorking.y) || 0) / workingH,
          wN:  (Number(boxInWorking.w) || 0) / workingW,
          hN:  (Number(boxInWorking.h) || 0) / workingH
        };
      },
      fromNormalized(normBox){
        if(!normBox) return null;
        return {
          x: (Number(normBox.x0n) || 0) * workingW,
          y: (Number(normBox.y0n) || 0) * workingH,
          w: (Number(normBox.wN)  || 0) * workingW,
          h: (Number(normBox.hN)  || 0) * workingH,
          page: userBoxDisplay.page
        };
      },
      getOffscreenCanonicalCanvas(){
        const canvases = state?.wfg4?.canonicalCanvases;
        if(!canvases) return null;
        return canvases[idx] || null;
      },
      cropWorkingImage(boxInWorking){
        const src = frame.getOffscreenCanonicalCanvas();
        if(!src || typeof document === 'undefined') return null;
        const b = boxInWorking || userBoxWorking;
        const x = Math.max(0, Math.min(workingW, Math.round(b.x)));
        const y = Math.max(0, Math.min(workingH, Math.round(b.y)));
        const w = Math.max(1, Math.min(workingW - x, Math.round(b.w)));
        const h = Math.max(1, Math.min(workingH - y, Math.round(b.h)));
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
        return out;
      }
    };
    return { ok: true, reasons: [], frame: Object.freeze(frame) };
  }

  /**
   * Build or refresh the per-page offscreen canonical canvases from a WFG4
   * surface. Called by the viewer glue code once a surface is ready. The
   * resulting canvases are the *only* sanctioned pixel source for vision
   * engine paths (Tesseract crops, OpenCV feature extraction, etc.) — the
   * on-screen els.pdfCanvas is UI-only from now on.
   */
  function buildOffscreenCanonicalCanvases(surface){
    if(typeof document === 'undefined') return Promise.resolve([]);
    if(!surface || !Array.isArray(surface.pages) || !surface.pages.length) return Promise.resolve([]);
    const tasks = surface.pages.map((page, idx) => new Promise(resolve => {
      try {
        const dims = page?.dimensions?.working || page?.dimensions?.original || {};
        const width = Math.max(1, Math.round(dims.width || 1));
        const height = Math.max(1, Math.round(dims.height || 1));
        const url = page?.artifacts?.displayDataUrl || page?.artifacts?.grayDataUrl || page?.artifacts?.edgeDataUrl || null;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if(!url){
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          resolve({ idx, canvas });
          return;
        }
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, width, height);
          resolve({ idx, canvas });
        };
        img.onerror = () => {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          resolve({ idx, canvas });
        };
        img.src = url;
      } catch(_err){
        resolve({ idx, canvas: null });
      }
    }));
    return Promise.all(tasks);
  }

  global.WFG4CaptureFrame = {
    build: buildCaptureFrame,
    invariantsReport,
    buildOffscreenCanonicalCanvases
  };
})(typeof window !== 'undefined' ? window : this);
