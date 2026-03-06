(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WrokitVisionEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const LABEL_HINTS = {
    store_name: ['vendor','seller','company','store','business'],
    department: ['department','division'],
    invoice_number: ['invoice #','invoice no','invoice number','inv #'],
    invoice_date: ['invoice date','issued','date'],
    salesperson: ['salesperson','sales rep','rep'],
    customer_name: ['sold to','bill to','customer'],
    customer_address: ['address','bill to','sold to'],
    subtotal_amount: ['subtotal'],
    discounts_amount: ['discount'],
    tax_amount: ['tax','hst','gst','vat','pst'],
    invoice_total: ['grand total','amount due','balance due','total']
  };

  function cleanText(text){
    return String(text || '').replace(/\s+/g, ' ').replace(/[#:]+$/g, '').trim();
  }

  function dedupeRepeats(text){
    return String(text || '').replace(/\b(.+?)\s+\1\b/gi, '$1').trim();
  }

  function expandBox(base, pad){
    return {
      x: base.x - pad,
      y: base.y - pad,
      w: base.w + (pad * 2),
      h: base.h + (pad * 2),
      page: base.page
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
      return (overlap / area) >= minOverlap;
    });
  }

  function lineBandThreshold(tok){
    return Math.max(5, (tok?.h || 10) * 0.65);
  }

  function groupByLines(tokens){
    const sorted = (tokens || []).slice().sort((a,b)=> (a.y - b.y) || (a.x - b.x));
    const lines = [];
    for(const tok of sorted){
      const cy = (tok.y || 0) + ((tok.h || 0) / 2);
      let target = lines.find(line => Math.abs(cy - line.cy) <= lineBandThreshold(tok));
      if(!target){
        target = { cy, tokens: [] };
        lines.push(target);
      }
      target.tokens.push(tok);
      target.cy = (target.cy * (target.tokens.length - 1) + cy) / target.tokens.length;
    }
    return lines.map(line => {
      line.tokens.sort((a,b)=> (a.x || 0) - (b.x || 0));
      line.text = dedupeRepeats(cleanText(line.tokens.map(t => t.text || '').join(' ')));
      return line;
    });
  }

  function parseMoney(text){
    const m = String(text || '').match(/-?\$?\s*\d[\d,]*(?:\.\d{2})?/);
    if(!m) return null;
    return Number(m[0].replace(/[^\d.-]/g, ''));
  }

  function looksDate(text){
    return /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b[a-z]{3,9}\s+\d{1,2},\s*\d{4}\b/i.test(text || '');
  }

  function scoreFieldFormat(fieldKey, text){
    const t = String(text || '');
    if(!t) return 0;
    if(fieldKey === 'invoice_number'){
      return /[a-z0-9][a-z0-9\-_/\.]{2,}/i.test(t) && !looksDate(t) ? 1 : 0;
    }
    if(fieldKey === 'invoice_date') return looksDate(t) ? 1 : 0;
    if(/total|subtotal|tax|discount/.test(fieldKey || '')) return parseMoney(t) !== null ? 1 : 0;
    if(fieldKey === 'quantity') return /^\s*\d+(?:\.\d+)?\s*$/.test(t) ? 1 : 0;
    return 0.4;
  }

  function buildCandidate(fieldSpec, line, centerX, centerY){
    const fieldKey = fieldSpec?.fieldKey || '';
    const hints = LABEL_HINTS[fieldKey] || [];
    const lower = String(line?.text || '').toLowerCase();
    const cx = line.tokens.reduce((sum, tok)=> sum + ((tok.x || 0) + ((tok.w || 0) / 2)), 0) / Math.max(1, line.tokens.length);
    const cy = line.cy || centerY;
    const distance = Math.abs(cx - centerX) + Math.abs(cy - centerY);

    let score = 0;
    if(hints.some(h => lower.includes(h))) score += 1.1;
    score += scoreFieldFormat(fieldKey, line.text);
    score += Math.max(0, 1 - (distance / 550));

    return {
      text: line.text,
      raw: line.text,
      tokens: line.tokens,
      cx,
      cy,
      score
    };
  }

  function resolveFallback(fieldSpec, candidates, boxPx){
    if(candidates.length){
      const winner = candidates[0];
      return {
        value: winner.text,
        raw: winner.raw,
        confidence: Math.max(0.2, Math.min(0.55, winner.score / 2.5)),
        boxPx,
        tokens: winner.tokens,
        method: 'wrokit-vision-fallback',
        engine: 'wrokit_vision',
        lowConfidence: true
      };
    }
    return {
      value: '',
      raw: '',
      confidence: 0.1,
      boxPx,
      tokens: [],
      method: 'wrokit-vision-empty-fallback',
      engine: 'wrokit_vision',
      lowConfidence: true
    };
  }

  function extractScalar({ fieldSpec, tokens, boxPx }){
    if(!boxPx){
      return { value: '', raw: '', confidence: 0.1, boxPx: null, tokens: [], method:'wrokit-vision-no-box', engine:'wrokit_vision', lowConfidence:true };
    }
    const centerX = boxPx.x + (boxPx.w / 2);
    const centerY = boxPx.y + (boxPx.h / 2);
    const pads = [0, 4, 8, 12, 16];
    let lastCandidates = [];
    let lastScope = boxPx;

    for(const pad of pads){
      const scope = pad ? expandBox(boxPx, pad) : boxPx;
      lastScope = scope;
      const scoped = tokensInBox(tokens || [], scope, 0.25);
      const lines = groupByLines(scoped).filter(line => !!line.text);
      const ranked = lines
        .map(line => buildCandidate(fieldSpec, line, centerX, centerY))
        .sort((a,b)=> b.score - a.score);
      lastCandidates = ranked;
      if(ranked[0]){
        const winner = ranked[0];
        const confidence = Math.max(0.2, Math.min(0.96, winner.score / 2.4));
        if(confidence >= 0.64){
          return {
            value: winner.text,
            raw: winner.raw,
            confidence,
            boxPx: scope,
            tokens: winner.tokens,
            method: pad ? 'wrokit-vision-micro-expansion' : 'wrokit-vision-in-box',
            engine: 'wrokit_vision',
            lowConfidence: false
          };
        }
      }
    }

    return resolveFallback(fieldSpec, lastCandidates, lastScope);
  }

  function registerField({ step, normBox, page, rawBox, viewport }){
    return {
      schema: 'wrokit_vision/v1',
      method: 'bbox-first-micro-expansion',
      fieldKey: step?.fieldKey || null,
      labelHints: LABEL_HINTS[step?.fieldKey] || [],
      page,
      bbox: {
        x0: normBox?.x0n,
        y0: normBox?.y0n,
        x1: (normBox?.x0n || 0) + (normBox?.wN || 0),
        y1: (normBox?.y0n || 0) + (normBox?.hN || 0)
      },
      viewport: viewport ? { width: viewport.width || viewport.w || 0, height: viewport.height || viewport.h || 0 } : null,
      rawBox: rawBox ? { x: rawBox.x, y: rawBox.y, w: rawBox.w, h: rawBox.h } : null
    };
  }

  return {
    registerField,
    extractScalar
  };
});
