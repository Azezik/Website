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

  function median(nums=[]){
    if(!nums.length) return 0;
    const sorted = nums.slice().sort((a,b)=>a-b);
    const mid = Math.floor(sorted.length/2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
  }

  function summarizeLineMetrics(lines=[]){
    const heights = (lines||[]).map(L => {
      if(L?.height && Number.isFinite(L.height)) return L.height;
      const tokens = L?.tokens || [];
      if(!tokens.length) return 0;
      const ys = tokens.map(t=>t.y||0);
      const y2s = tokens.map(t=>(t.y||0)+(t.h||0));
      const minY = Math.min(...ys);
      const maxY = Math.max(...y2s);
      return maxY - minY;
    }).filter(h => Number.isFinite(h) && h > 0);
    const lineCount = (lines||[]).length;
    if(!heights.length) return { lineCount, lineHeights: { min:0, max:0, median:0 } };
    return {
      lineCount,
      lineHeights: {
        min: Math.min(...heights),
        max: Math.max(...heights),
        median: median(heights)
      }
    };
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
    const lineMetrics = summarizeLineMetrics(lines);
    if(!hits.length && snappedText){
      return { hits, lines, text: snappedText.trim(), box, lineMetrics, lineCount: lineMetrics.lineCount, lineHeights: lineMetrics.lineHeights };
    }
    const joined = lines.map(L => L.tokens.map(t=>t.text).join(' ').trim()).filter(Boolean);
    const text = (multiline || joined.length > 1)
      ? joined.join('\n')
      : (joined[0] || '');
    return { hits, lines, text, box, lineMetrics, lineCount: lineMetrics.lineCount, lineHeights: lineMetrics.lineHeights };
  }

  function collectFullText(tokens, box, snappedText='', opts={}){
    const { multiline=true, minOverlap=0.5, lineTol=4 } = opts || {};
    return assembleTextFromBox({ tokens, box, snappedText, multiline, minOverlap, lineTol });
  }

  // Shared helper for CONFIG and RUN flows. Given the user's saved selection
  // (or an already-snapped search box), assemble the text in a consistent way
  // so both modes agree on the final value and line metrics.
  function assembleStaticFieldPipeline(opts={}){
    const { tokens=[], selectionBox=null, searchBox=null, snappedText='', multiline=true, minOverlap=0.5, lineTol=4 } = opts || {};
    const box = searchBox || selectionBox;
    const assembled = assembleTextFromBox({ tokens, box, snappedText, multiline, minOverlap, lineTol });
    return { ...assembled, usedBox: box };
  }

  function extractConfigStatic(opts){
    const { tokens=[], box, snappedText='', cleanFn, fieldKey, mode='CONFIG', multiline=true } = opts || {};
    const { hits, text, box: usedBox, lineMetrics, lineCount, lineHeights } = collectFullText(tokens, box, snappedText, { multiline });
    const cleaned = cleanFn ? cleanFn(fieldKey || '', text, mode) : null;
    return { hits, text, box: usedBox, cleaned, lineMetrics, lineCount, lineHeights };
  }

  function finalizeConfigValue(opts){
    const { tokens=[], selectionBox=null, snappedBox=null, snappedText='', cleanFn, fieldKey, multiline=true } = opts || {};
    const chosenBox = selectionBox || snappedBox || null;
    const { hits, text, box, lineMetrics, lineCount, lineHeights } = extractConfigStatic({ tokens, box: chosenBox, snappedText, cleanFn, fieldKey, mode:'CONFIG', multiline });
    const raw = text || snappedText || '';
    const cleaned = cleanFn ? cleanFn(fieldKey || '', raw, 'CONFIG') : null;
    return { hits, text: raw, value: raw, raw, box, cleaned, lineMetrics, lineCount, lineHeights };
  }

  return { extractConfigStatic, finalizeConfigValue, collectFullText, groupIntoLines, tokensInBox, assembleTextFromBox, assembleStaticFieldPipeline };
});
