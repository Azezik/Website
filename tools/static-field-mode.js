(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaticFieldMode = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  function groupIntoLines(tokens, tol=4){
    const sorted = (tokens||[]).slice().sort((a,b)=> (a.y + a.h/2) - (b.y + b.h/2));
    const lines = [];
    for(const t of sorted){
      const cy = (t.y || 0) + (t.h || 0)/2;
      const line = lines.find(L => Math.abs(L.cy - cy) <= tol && L.page === t.page);
      if(line){
        line.tokens.push(t);
        line.cy = (line.cy*line.tokens.length + cy)/(line.tokens.length+1);
      } else {
        lines.push({page:t.page, cy, tokens:[t]});
      }
    }
    lines.forEach(L => L.tokens.sort((a,b)=> (a.x||0) - (b.x||0)));
    return lines;
  }

  function tokensInBox(tokens, box, opts={}){
    const { minOverlap=0.5 } = opts || {};
    if(!box) return [];
    return (tokens||[]).filter(t => {
      if(t.page !== box.page) return false;
      const cx = (t.x||0) + (t.w||0)/2;
      if(cx < box.x || cx > box.x + box.w) return false;
      const overlapY = Math.min((t.y||0) + (t.h||0), box.y + box.h) - Math.max(t.y||0, box.y);
      if((t.h||1) === 0) return false;
      if(overlapY / (t.h||1) < minOverlap) return false;
      return true;
    }).sort((a,b)=>{
      const ay = (a.y||0) + (a.h||0)/2;
      const by = (b.y||0) + (b.h||0)/2;
      return ay === by ? (a.x||0) - (b.x||0) : ay - by;
    });
  }

  function assembleTextFromBox({ tokens, box, snappedText='', multiline=false, minOverlap=0.5, lineTol=4 }){
    const hits = tokensInBox(tokens, box, { minOverlap });
    const lines = groupIntoLines(hits, lineTol);
    for(const line of lines){
      const ys = (line.tokens||[]).map(t=>t.y||0);
      const y2s = (line.tokens||[]).map(t=>(t.y||0)+(t.h||0));
      const top = ys.length ? Math.min(...ys) : (box?.y ?? 0);
      const bottom = y2s.length ? Math.max(...y2s) : top;
      line.top = top;
      line.bottom = bottom;
      line.height = Math.max(0, bottom - top);
    }
    if(!hits.length && snappedText){
      return { hits, lines, text: snappedText.trim(), box };
    }
    const joined = lines.map(L => L.tokens.map(t=>t.text).join(' ').trim()).filter(Boolean);
    const text = (multiline || joined.length > 1)
      ? joined.join('\n')
      : (joined[0] || '');
    return { hits, lines, text, box };
  }

  function collectFullText(tokens, box, snappedText='', opts={}){
    const { multiline=true, minOverlap=0.5, lineTol=4 } = opts || {};
    return assembleTextFromBox({ tokens, box, snappedText, multiline, minOverlap, lineTol });
  }

  function extractConfigStatic(opts){
    const { tokens=[], box, snappedText='', cleanFn, fieldKey, mode='CONFIG', multiline=true } = opts || {};
    const { hits, text, box: usedBox } = collectFullText(tokens, box, snappedText, { multiline });
    const cleaned = cleanFn ? cleanFn(fieldKey || '', text, mode) : null;
    return { hits, text, box: usedBox, cleaned };
  }

  function finalizeConfigValue(opts){
    const { tokens=[], selectionBox=null, snappedBox=null, snappedText='', cleanFn, fieldKey, multiline=true } = opts || {};
    const chosenBox = selectionBox || snappedBox || null;
    const { hits, text, box } = extractConfigStatic({ tokens, box: chosenBox, snappedText, cleanFn, fieldKey, mode:'CONFIG', multiline });
    const raw = text || snappedText || '';
    const cleaned = cleanFn ? cleanFn(fieldKey || '', raw, 'CONFIG') : null;
    return { hits, text: raw, value: raw, raw, box, cleaned };
  }

  return { extractConfigStatic, finalizeConfigValue, collectFullText, groupIntoLines, tokensInBox, assembleTextFromBox };
});
