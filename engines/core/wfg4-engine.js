(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory(root);
  } else {
    root.WFG4Engine = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function(root){
  const Types = root.WFG4Types || {};
  const Registration = root.WFG4Registration || {};
  const Localization = root.WFG4Localization || {};

  const WFG4_SCHEMA_VERSION = Types.WFG4_SCHEMA_VERSION || 'wfg4/v0-phase3';
  const MAX_WORKING_EDGE = 1600;

  function cleanText(text){
    return String(text || '').replace(/\s+/g, ' ').replace(/[#:]+$/g, '').trim();
  }

  function expandBox(box, pad){
    return {
      x: (box?.x || 0) - pad,
      y: (box?.y || 0) - pad,
      w: Math.max(1, (box?.w || 1) + (pad * 2)),
      h: Math.max(1, (box?.h || 1) + (pad * 2)),
      page: box?.page
    };
  }

  function tokensInBox(tokens, box, minOverlap = 0.25){
    if(!Array.isArray(tokens) || !box) return [];
    return tokens.filter(tok => {
      const x0 = tok.x || 0;
      const y0 = tok.y || 0;
      const x1 = x0 + (tok.w || 0);
      const y1 = y0 + (tok.h || 0);
      const ox = Math.max(0, Math.min(box.x + box.w, x1) - Math.max(box.x, x0));
      const oy = Math.max(0, Math.min(box.y + box.h, y1) - Math.max(box.y, y0));
      const overlap = ox * oy;
      const area = Math.max(1, (tok.w || 0) * (tok.h || 0));
      return overlap / area >= minOverlap;
    });
  }

  function scoreToken(tok, centerX, centerY){
    const cx = (tok.x || 0) + ((tok.w || 0) / 2);
    const cy = (tok.y || 0) + ((tok.h || 0) / 2);
    const dist = Math.abs(cx - centerX) + Math.abs(cy - centerY);
    return Math.max(0, 1 - (dist / 600));
  }

  function pickBestToken(tokens, box){
    if(!Array.isArray(tokens) || !tokens.length || !box) return null;
    const centerX = (box.x || 0) + (box.w || 0) / 2;
    const centerY = (box.y || 0) + (box.h || 0) / 2;
    return tokens
      .map(tok => ({ tok, score: scoreToken(tok, centerX, centerY) }))
      .sort((a,b)=> b.score - a.score)[0] || null;
  }

  function toCanvasFromSource(source){
    if(!source) return null;
    if(typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement){
      return source;
    }
    if(source.canvas && typeof HTMLCanvasElement !== 'undefined' && source.canvas instanceof HTMLCanvasElement){
      return source.canvas;
    }
    if(typeof document === 'undefined') return null;
    const w = Math.max(1, Math.round(source.width || source.w || 0));
    const h = Math.max(1, Math.round(source.height || source.h || 0));
    if(!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if(!ctx) return null;
    if(source.imageData && source.imageData.data){
      try {
        ctx.putImageData(source.imageData, 0, 0);
        return canvas;
      } catch(_err){
        return null;
      }
    }
    return null;
  }

  function matToCanvas(mat){
    if(typeof document === 'undefined' || !mat || !mat.cols || !mat.rows) return null;
    const canvas = document.createElement('canvas');
    canvas.width = mat.cols;
    canvas.height = mat.rows;
    const cv = (typeof window !== 'undefined' ? window.cv : null);
    if(!cv || typeof cv.imshow !== 'function') return null;
    cv.imshow(canvas, mat);
    return canvas;
  }

  function makePageArtifactDataUrl(canvas){
    if(!canvas || typeof canvas.toDataURL !== 'function') return null;
    try {
      return canvas.toDataURL('image/png');
    } catch(_err){
      return null;
    }
  }

  function buildWorkingSize(width, height, maxEdge = MAX_WORKING_EDGE){
    const w = Math.max(1, Math.round(width || 1));
    const h = Math.max(1, Math.round(height || 1));
    const longest = Math.max(w, h);
    if(longest <= maxEdge){
      return { width: w, height: h, scaleX: 1, scaleY: 1 };
    }
    const factor = maxEdge / longest;
    const ww = Math.max(1, Math.round(w * factor));
    const wh = Math.max(1, Math.round(h * factor));
    return {
      width: ww,
      height: wh,
      scaleX: ww / w,
      scaleY: wh / h
    };
  }

  function normalizeWithOpenCv(inputCanvas, working){
    const cv = (typeof window !== 'undefined' ? window.cv : null);
    if(!cv || typeof cv.imread !== 'function'){
      throw new Error('opencv_unavailable');
    }
    const src = cv.imread(inputCanvas);
    const resized = new cv.Mat();
    const gray = new cv.Mat();
    const denoised = new cv.Mat();
    const edges = new cv.Mat();

    cv.resize(src, resized, new cv.Size(working.width, working.height), 0, 0, cv.INTER_AREA);
    cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, denoised, new cv.Size(3, 3), 0);
    cv.Canny(denoised, edges, 60, 160, 3, false);

    const meanGray = cv.mean(gray)[0] || 0;
    const meanEdge = cv.mean(edges)[0] || 0;

    const grayCanvas = matToCanvas(gray);
    const edgeCanvas = matToCanvas(edges);

    const out = {
      working,
      grayDataUrl: makePageArtifactDataUrl(grayCanvas),
      edgeDataUrl: makePageArtifactDataUrl(edgeCanvas),
      displayDataUrl: makePageArtifactDataUrl(grayCanvas) || makePageArtifactDataUrl(edgeCanvas),
      diagnostics: {
        meanGray,
        meanEdge,
        cvBackend: 'opencv.js'
      }
    };

    src.delete();
    resized.delete();
    gray.delete();
    denoised.delete();
    edges.delete();
    return out;
  }

  function normalizeWithCanvasFallback(inputCanvas, working){
    if(typeof document === 'undefined'){
      return {
        working,
        grayDataUrl: null,
        edgeDataUrl: null,
        displayDataUrl: null,
        diagnostics: {
          meanGray: null,
          meanEdge: null,
          cvBackend: 'unavailable'
        }
      };
    }
    const canvas = document.createElement('canvas');
    canvas.width = working.width;
    canvas.height = working.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.filter = 'grayscale(1) blur(0.6px)';
    ctx.drawImage(inputCanvas, 0, 0, working.width, working.height);
    ctx.filter = 'none';
    const grayDataUrl = makePageArtifactDataUrl(canvas);
    return {
      working,
      grayDataUrl,
      edgeDataUrl: null,
      displayDataUrl: grayDataUrl,
      diagnostics: {
        meanGray: null,
        meanEdge: null,
        cvBackend: 'canvas-fallback'
      }
    };
  }

  function normalizePage(pageInput = {}, opts = {}){
    const pageIndex = Number.isFinite(pageInput.pageIndex) ? pageInput.pageIndex : 0;
    const pageNumber = Number.isFinite(pageInput.pageNumber) ? pageInput.pageNumber : (pageIndex + 1);
    const canvas = toCanvasFromSource(pageInput);
    const originalWidth = Math.max(1, Math.round(pageInput.width || canvas?.width || 1));
    const originalHeight = Math.max(1, Math.round(pageInput.height || canvas?.height || 1));
    const working = buildWorkingSize(originalWidth, originalHeight, opts.maxWorkingEdge || MAX_WORKING_EDGE);

    if(!canvas){
      return {
        pageIndex,
        pageNumber,
        dimensions: {
          original: { width: originalWidth, height: originalHeight },
          working: { width: working.width, height: working.height }
        },
        scale: {
          workingFromOriginalX: working.scaleX,
          workingFromOriginalY: working.scaleY,
          originalFromWorkingX: working.scaleX > 0 ? 1 / working.scaleX : 1,
          originalFromWorkingY: working.scaleY > 0 ? 1 / working.scaleY : 1
        },
        artifacts: {
          displayDataUrl: pageInput.dataUrl || null,
          grayDataUrl: null,
          edgeDataUrl: null
        },
        diagnostics: {
          cvBackend: 'missing-canvas',
          hasInputCanvas: false
        }
      };
    }

    let normalized;
    try {
      normalized = normalizeWithOpenCv(canvas, working);
    } catch(_err){
      normalized = normalizeWithCanvasFallback(canvas, working);
    }

    return {
      pageIndex,
      pageNumber,
      dimensions: {
        original: { width: originalWidth, height: originalHeight },
        working: { width: working.width, height: working.height }
      },
      scale: {
        workingFromOriginalX: working.scaleX,
        workingFromOriginalY: working.scaleY,
        originalFromWorkingX: working.scaleX > 0 ? 1 / working.scaleX : 1,
        originalFromWorkingY: working.scaleY > 0 ? 1 / working.scaleY : 1
      },
      artifacts: {
        displayDataUrl: normalized.displayDataUrl || pageInput.dataUrl || null,
        grayDataUrl: normalized.grayDataUrl || null,
        edgeDataUrl: normalized.edgeDataUrl || null
      },
      diagnostics: normalized.diagnostics || {}
    };
  }

  function prepareDocumentSurface(payload = {}){
    const pagesInput = Array.isArray(payload.pages) ? payload.pages : [];
    const fallbackViewport = payload.viewport || {};
    const fallbackPage = {
      pageIndex: 0,
      pageNumber: Number.isFinite(payload.activePage) ? payload.activePage : 1,
      width: Number(fallbackViewport.width || fallbackViewport.w || 0) || 1,
      height: Number(fallbackViewport.height || fallbackViewport.h || 0) || 1,
      dataUrl: null
    };
    const sourcePages = pagesInput.length ? pagesInput : [fallbackPage];
    const normalizedPages = sourcePages.map(page => normalizePage(page, { maxWorkingEdge: payload.maxWorkingEdge || MAX_WORKING_EDGE }));

    return {
      schema: WFG4_SCHEMA_VERSION,
      phase: 'phase3-visual-localization',
      mode: payload.mode || 'unknown',
      fileName: payload.fileName || '',
      mimeType: payload.mimeType || '',
      isImage: !!payload.isImage,
      geometryId: payload.geometryId || null,
      wizardId: payload.wizardId || null,
      pageCount: normalizedPages.length,
      activePage: Number.isFinite(payload.activePage) ? payload.activePage : 1,
      coordinateSpace: Types.WFG4_NORMALIZATION_VERSION || 'wfg4-canonical-working-v1',
      pages: normalizedPages,
      diagnostics: {
        cvAvailable: !!(typeof window !== 'undefined' && window.cv && typeof window.cv.imread === 'function'),
        maxWorkingEdge: payload.maxWorkingEdge || MAX_WORKING_EDGE,
        generatedAt: new Date().toISOString()
      }
    };
  }

  async function registerField(payload = {}){
    if(Registration.captureVisualReferencePacket){
      return Registration.captureVisualReferencePacket(payload);
    }
    return {
      schema: WFG4_SCHEMA_VERSION,
      method: 'bbox-first-canonical-surface',
      engineType: 'wfg4',
      coordinateSpace: Types.WFG4_NORMALIZATION_VERSION || 'wfg4-canonical-working-v1',
      page: payload.page || 1,
      fieldKey: payload.step?.fieldKey || null,
      phase3Ready: false
    };
  }

  function mapTokensToCanonical(tokens, boxPx, wfg4Surface){
    if(!Array.isArray(tokens) || !boxPx || !wfg4Surface?.pages) return tokens || [];
    const pageIdx = Math.max(0, (boxPx.page || 1) - 1);
    const page = wfg4Surface.pages[pageIdx];
    if(!page?.scale) return tokens;
    const sx = Number(page.scale.workingFromOriginalX || 1);
    const sy = Number(page.scale.workingFromOriginalY || 1);
    if(Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return tokens;
    return tokens.map(tok => ({
      ...tok,
      x: Number(tok.x || 0) * sx,
      y: Number(tok.y || 0) * sy,
      w: Number(tok.w || 0) * sx,
      h: Number(tok.h || 0) * sy
    }));
  }

  async function extractScalar(payload = {}){
    const fieldSpec = payload.fieldSpec || {};
    const boxPx = payload.boxPx || null;
    const rawTokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    const allTokens = mapTokensToCanonical(rawTokens, boxPx, payload.wfg4Surface || null);

    const localized = Localization.localizeFieldVisual
      ? await Localization.localizeFieldVisual({
          ...payload,
          wfg4Config: fieldSpec.wfg4Config || payload.wfg4Config || null,
          boxPx: boxPx || null
        })
      : { ok:false, localizedBox: boxPx || null, localizationConfidence: 0.1, reason: 'localization_module_missing' };

    const finalBox = localized.localizedBox || boxPx;
    if(!finalBox){
      return {
        value: '',
        raw: '',
        confidence: 0.05,
        boxPx: null,
        tokens: [],
        method: 'wfg4-no-box',
        engine: 'wfg4',
        lowConfidence: true,
        extractionMeta: {
          schema: WFG4_SCHEMA_VERSION,
          reason: 'missing_box',
          localization: localized
        }
      };
    }

    const pads = [0, 4, 8];
    let winner = null;
    for(const pad of pads){
      const scoped = tokensInBox(allTokens, pad ? expandBox(finalBox, pad) : finalBox, 0.2);
      const candidate = pickBestToken(scoped, finalBox);
      if(candidate?.tok?.text){
        winner = {
          token: candidate.tok,
          pad,
          score: candidate.score,
          scoped
        };
        if(candidate.score >= 0.6) break;
      }
    }

    if(!winner){
      return {
        value: '',
        raw: '',
        confidence: Math.max(0.08, (localized.localizationConfidence || 0) * 0.4),
        boxPx: finalBox,
        tokens: [],
        method: 'wfg4-localized-empty',
        engine: 'wfg4',
        lowConfidence: true,
        extractionMeta: {
          schema: WFG4_SCHEMA_VERSION,
          fieldKey: fieldSpec.fieldKey || null,
          reason: 'no_token_in_localized_scope',
          localization
        }
      };
    }

    const value = cleanText(winner.token.text || winner.token.raw || '');
    const readConfidence = Math.max(0.15, Math.min(0.85, 0.2 + (winner.score * 0.55)));
    return {
      value,
      raw: value,
      confidence: readConfidence,
      boxPx: finalBox,
      tokens: winner.scoped,
      method: winner.pad ? 'wfg4-localized-micro-expansion' : 'wfg4-localized-in-box',
      engine: 'wfg4',
      extractionMeta: {
        schema: WFG4_SCHEMA_VERSION,
        fieldKey: fieldSpec.fieldKey || null,
        usedPad: winner.pad,
        scopedTokenCount: winner.scoped.length,
        localization,
        readout: {
          confidence: readConfidence,
          source: 'localized-token-read-assist'
        }
      }
    };
  }

  return {
    WFG4_SCHEMA_VERSION,
    prepareDocumentSurface,
    registerField,
    extractScalar
  };
});
