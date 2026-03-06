(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineAIExtraction = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const LABEL_HINTS = {
    store_name: ['vendor','seller','company','store','business'],
    invoice_number: ['invoice #','invoice no','invoice number','inv #'],
    invoice_date: ['invoice date','issued','date'],
    subtotal_amount: ['subtotal'],
    discounts_amount: ['discount'],
    tax_amount: ['tax','hst','gst','vat','pst'],
    invoice_total: ['grand total','amount due','balance due','total']
  };

  function cleanText(text){
    return String(text || '').replace(/\s+/g, ' ').replace(/[#:]+$/g, '').trim();
  }

  function tokensInBox(tokens, box, options = {}){
    if(!Array.isArray(tokens) || !box) return [];
    const minOverlap = Number.isFinite(options.minOverlap) ? options.minOverlap : 0.4;
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

  function groupByLines(tokens){
    const sorted = tokens.slice().sort((a,b)=> (a.y - b.y) || (a.x - b.x));
    const lines = [];
    for(const tok of sorted){
      const cy = tok.y + (tok.h || 0) / 2;
      let line = lines.find(item => Math.abs(cy - item.cy) <= Math.max(4, (tok.h || 10) * 0.6));
      if(!line){
        line = { cy, tokens: [] };
        lines.push(line);
      }
      line.tokens.push(tok);
      line.cy = (line.cy * (line.tokens.length - 1) + cy) / line.tokens.length;
    }
    return lines.map(line => {
      line.tokens.sort((a,b)=> a.x - b.x);
      line.text = cleanText(line.tokens.map(t => t.text || '').join(' '));
      return line;
    });
  }

  function collapseRepeatedPhrase(text){
    if(!text) return '';
    return text.replace(/\b(.+?)\s+\1\b/gi, '$1').trim();
  }

  function scoreCandidate(fieldKey, candidate, centerX, centerY){
    const txt = candidate.text || '';
    let score = 0;
    const hints = LABEL_HINTS[fieldKey] || [];
    if(hints.some(h => txt.toLowerCase().includes(h))) score += 0.8;
    if(/date/i.test(fieldKey) && /\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}|[a-z]{3,9}\s+\d{1,2},\s*\d{4}/i.test(txt)) score += 1;
    if(/total|subtotal|tax|discount/i.test(fieldKey) && /\$?\s*-?\d+[\d,]*(?:\.\d{2})?/.test(txt)) score += 1;
    if(/invoice_number/i.test(fieldKey) && /[a-z0-9-]{3,}/i.test(txt) && !/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(txt)) score += 1;
    const dx = Math.abs((candidate.cx || centerX) - centerX);
    const dy = Math.abs((candidate.cy || centerY) - centerY);
    score += Math.max(0, 1 - ((dx + dy) / 500));
    return score;
  }

  function valueFromLine(line){
    const words = line.text.split(/\s+/);
    if(words.length < 2) return line.text;
    const labelIdx = words.findIndex(w => /invoice|date|subtotal|total|tax|discount|vendor|store/i.test(w));
    if(labelIdx >= 0 && labelIdx < words.length - 1){
      return cleanText(words.slice(labelIdx + 1).join(' '));
    }
    return line.text;
  }

  function expandBox(base, pad){
    return {
      x: base.x - pad,
      y: base.y - pad,
      w: base.w + pad * 2,
      h: base.h + pad * 2,
      page: base.page
    };
  }

  function extractScalar({ fieldSpec, tokens, boxPx }){
    const centerX = boxPx.x + boxPx.w / 2;
    const centerY = boxPx.y + boxPx.h / 2;
    const steps = [0, 4, 8, 12, 16];
    let best = null;
    for(const pad of steps){
      const scope = pad ? expandBox(boxPx, pad) : boxPx;
      const inBox = tokensInBox(tokens, scope, { minOverlap: 0.25 });
      const lines = groupByLines(inBox);
      const candidates = lines.map(line => {
        const cx = line.tokens.reduce((s,t)=> s + (t.x + t.w/2), 0) / Math.max(1, line.tokens.length);
        return { text: collapseRepeatedPhrase(valueFromLine(line)), cx, cy: line.cy, line };
      }).filter(c => c.text);
      const ranked = candidates.map(c => ({ ...c, score: scoreCandidate(fieldSpec.fieldKey || '', c, centerX, centerY) }))
        .sort((a,b)=> b.score - a.score);
      if(ranked[0]){
        const winner = ranked[0];
        const confidence = Math.max(0.2, Math.min(0.98, winner.score / 2.5));
        best = {
          value: winner.text,
          raw: winner.line?.text || winner.text,
          confidence,
          boxPx: scope,
          tokens: winner.line?.tokens || inBox,
          method: pad ? 'ai-micro-expansion' : 'ai-in-box',
          engine: 'ai_algo'
        };
        if(confidence >= 0.65) return best;
      }
    }
    return best || { value: '', raw: '', confidence: 0.1, boxPx, tokens: [], method: 'ai-fallback', engine: 'ai_algo' };
  }

  function registerField({ step, normBox, page, rawBox, viewport }){
    const hints = LABEL_HINTS[step?.fieldKey] || [];
    return {
      schema: 'ai_algo/v1',
      strategy: 'bbox-first-micro-expansion-v1',
      page,
      hints,
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
