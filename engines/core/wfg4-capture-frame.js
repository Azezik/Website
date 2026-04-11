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

  function invariantsReport({ pageNum, state }){
    const idx = Math.max(0, (Number(pageNum) || 1) - 1);
    const surface = state?.wfg4?.configSurface || null;
    const pageEntry = surface?.pages?.[idx] || null;
    const reasons = [];
    if(!surface || !Array.isArray(surface.pages) || !surface.pages.length) reasons.push('config_surface_missing');
    if(!pageEntry) reasons.push('page_entry_missing');
    const working = pageEntry?.dimensions?.working || null;
    if(!working || !(working.width > 0) || !(working.height > 0)) reasons.push('working_dims_missing');
    const original = pageEntry?.dimensions?.original || null;
    if(!original || !(original.width > 0) || !(original.height > 0)) reasons.push('original_dims_missing');
    if(!pageEntry?.artifacts?.displayDataUrl) reasons.push('display_data_url_missing');
    if(!pageEntry?.pageStructure) reasons.push('page_structure_missing');
    return { pageEntry, reasons };
  }

  function clampBoxToBounds(box, W, H){
    const bx = Math.max(0, Math.min(W, Number(box?.x) || 0));
    const by = Math.max(0, Math.min(H, Number(box?.y) || 0));
    const bw = Math.max(0, Math.min(W - bx, Number(box?.w) || 0));
    const bh = Math.max(0, Math.min(H - by, Number(box?.h) || 0));
    return { x: bx, y: by, w: bw, h: bh };
  }

  function buildCaptureFrame({ pageNum, userBoxDisplayPx, state }){
    const idx = Math.max(0, (Number(pageNum) || 1) - 1);
    const { pageEntry, reasons } = invariantsReport({ pageNum, state });
    if(!pageEntry
        || !pageEntry.dimensions?.working
        || !pageEntry.dimensions?.original
        || !pageEntry.artifacts?.displayDataUrl){
      return { ok: false, reasons, frame: null };
    }
    // `working` = canonical working pixel space (after maxWorkingEdge clamp).
    // `original` = the native display canvas pixel space the user actually
    // dragged on (pdfCanvas / imgCanvas). These can differ whenever a page's
    // longest edge exceeds MAX_WORKING_EDGE (e.g. high-DPR PDFs, large scans).
    // Prior to this fix the frame collapsed display == working, which silently
    // corrupted every normBox / crop produced from a retina or large-image
    // surface — user dragged in display px, frame divided by working dims.
    // We now carry both spaces explicitly and expose a real display→working
    // scale factor so one geometry authority can serve both.
    const working = pageEntry.dimensions.working;
    const original = pageEntry.dimensions.original;
    const workingW = Math.max(1, Math.round(working.width));
    const workingH = Math.max(1, Math.round(working.height));
    const displayW = Math.max(1, Math.round(original.width));
    const displayH = Math.max(1, Math.round(original.height));
    const sX = workingW / displayW;
    const sY = workingH / displayH;

    const ubdRaw = userBoxDisplayPx || {};
    const ubdClamped = clampBoxToBounds(ubdRaw, displayW, displayH);
    const userBoxDisplay = Object.freeze({
      x: ubdClamped.x,
      y: ubdClamped.y,
      w: ubdClamped.w,
      h: ubdClamped.h,
      page: Number(pageNum) || 1
    });
    const ubwClamped = clampBoxToBounds({
      x: userBoxDisplay.x * sX,
      y: userBoxDisplay.y * sY,
      w: userBoxDisplay.w * sX,
      h: userBoxDisplay.h * sY
    }, workingW, workingH);
    const userBoxWorking = Object.freeze({
      x: ubwClamped.x,
      y: ubwClamped.y,
      w: ubwClamped.w,
      h: ubwClamped.h,
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
      sourceType: state?.isImage ? 'image-visual-intake' : 'pdf-raster-visual-intake',
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
        // Floor the origin and ceil the opposite edge so we never lose a
        // sub-pixel sliver of the region the user drew. Clamp both edges to
        // the working surface bounds so boxes dragged past the edge of the
        // document (including the common "finish outside canvas" case) still
        // produce a valid crop instead of an empty or negative rect.
        const b = boxInWorking || userBoxWorking;
        const x0 = Math.max(0, Math.min(workingW, Math.floor(Number(b.x) || 0)));
        const y0 = Math.max(0, Math.min(workingH, Math.floor(Number(b.y) || 0)));
        const x1 = Math.max(0, Math.min(workingW, Math.ceil((Number(b.x) || 0) + (Number(b.w) || 0))));
        const y1 = Math.max(0, Math.min(workingH, Math.ceil((Number(b.y) || 0) + (Number(b.h) || 0))));
        const w = Math.max(1, x1 - x0);
        const h = Math.max(1, y1 - y0);
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(src, x0, y0, w, h, 0, 0, w, h);
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
