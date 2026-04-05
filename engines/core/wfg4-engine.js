(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WFG4Engine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const WFG4_SCHEMA_VERSION = 'wfg4/v0-phase1';

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

  function prepareDocumentSurface(payload = {}){
    const viewport = payload.viewport || {};
    const width = Number(viewport.width || viewport.w || 0);
    const height = Number(viewport.height || viewport.h || 0);
    return {
      schema: WFG4_SCHEMA_VERSION,
      phase: 'phase1-scaffold',
      mode: payload.mode || 'unknown',
      fileName: payload.fileName || '',
      mimeType: payload.mimeType || '',
      isImage: !!payload.isImage,
      geometryId: payload.geometryId || null,
      wizardId: payload.wizardId || null,
      pageCount: Number.isFinite(payload.pageCount) ? payload.pageCount : 0,
      activePage: Number.isFinite(payload.activePage) ? payload.activePage : 1,
      normalizedViewport: {
        width: width > 0 ? width : 0,
        height: height > 0 ? height : 0,
        units: 'px',
        status: width > 0 && height > 0 ? 'ready' : 'pending'
      },
      // Phase 2 insertion points:
      // - upload normalization pipeline
      // - token rasterization surface
      // - OpenCV region proposals
      // - structure graph anchors
      phase2: {
        uploadNormalization: 'todo',
        tokenRasterization: 'todo',
        regionExtraction: 'todo',
        structuralAnchoring: 'todo'
      }
    };
  }

  function registerField(payload = {}){
    const normBox = payload.normBox || {};
    const viewport = payload.viewport || {};
    return {
      schema: WFG4_SCHEMA_VERSION,
      method: 'bbox-first-placeholder',
      page: payload.page || 1,
      geometryId: payload.geometryId || null,
      fieldKey: payload.step?.fieldKey || null,
      bbox: {
        x0: normBox.x0n,
        y0: normBox.y0n,
        x1: (normBox.x0n || 0) + (normBox.wN || 0),
        y1: (normBox.y0n || 0) + (normBox.hN || 0)
      },
      viewport: {
        width: viewport.width || viewport.w || 0,
        height: viewport.height || viewport.h || 0
      },
      rawBox: payload.rawBox ? {
        x: payload.rawBox.x,
        y: payload.rawBox.y,
        w: payload.rawBox.w,
        h: payload.rawBox.h
      } : null,
      // Phase 2: engine-owned configuration artifacts land here.
      phase2Ready: true
    };
  }

  function extractScalar(payload = {}){
    const fieldSpec = payload.fieldSpec || {};
    const boxPx = payload.boxPx || null;
    const allTokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    if(!boxPx){
      return {
        value: '',
        raw: '',
        confidence: 0.05,
        boxPx: null,
        tokens: [],
        method: 'wfg4-no-box',
        engine: 'wfg4',
        lowConfidence: true,
        extractionMeta: { schema: WFG4_SCHEMA_VERSION, reason: 'missing_box' }
      };
    }

    const pads = [0, 4, 8];
    let winner = null;
    for(const pad of pads){
      const scoped = tokensInBox(allTokens, pad ? expandBox(boxPx, pad) : boxPx, 0.2);
      const candidate = pickBestToken(scoped, boxPx);
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
        confidence: 0.1,
        boxPx,
        tokens: [],
        method: 'wfg4-placeholder-empty',
        engine: 'wfg4',
        lowConfidence: true,
        extractionMeta: {
          schema: WFG4_SCHEMA_VERSION,
          fieldKey: fieldSpec.fieldKey || null,
          reason: 'no_token_in_scope'
        }
      };
    }

    const value = cleanText(winner.token.text || winner.token.raw || '');
    const confidence = Math.max(0.15, Math.min(0.75, 0.2 + (winner.score * 0.55)));
    return {
      value,
      raw: value,
      confidence,
      boxPx,
      tokens: winner.scoped,
      method: winner.pad ? 'wfg4-micro-expansion-placeholder' : 'wfg4-in-box-placeholder',
      engine: 'wfg4',
      extractionMeta: {
        schema: WFG4_SCHEMA_VERSION,
        fieldKey: fieldSpec.fieldKey || null,
        usedPad: winner.pad,
        scopedTokenCount: winner.scoped.length
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
