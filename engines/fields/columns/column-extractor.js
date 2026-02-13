(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineColumnExtractor = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const cleanedTokenText = str => String(str || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

  function normalizeGuardList(list){
    return Array.from(new Set((list || []).map(w => cleanedTokenText(w)).filter(Boolean)));
  }

  function buildRowBands(anchorTokens, pageHeight){
    if(!anchorTokens.length) return [];
    const ordered = anchorTokens.slice().sort((a,b)=> a.cy - b.cy || a.y - b.y || a.x - b.x);
    const groups=[];
    let current=null;
    for(const tok of ordered){
      if(!current){
        current={ tokens:[tok], sumCy: tok.cy, count:1, cy: tok.cy, height: tok.h, text:(tok.text||'').trim() };
        continue;
      }
      const gap=Math.abs(tok.cy - current.cy);
      const threshold=Math.max(current.height, tok.h)*0.65;
      if(gap <= threshold){
        current.tokens.push(tok);
        current.sumCy += tok.cy;
        current.count += 1;
        current.cy = current.sumCy/current.count;
        current.height = Math.max(current.height, tok.h);
        current.text = current.tokens.map(t=>t.text).join(' ');
      } else {
        groups.push(current);
        current={ tokens:[tok], sumCy: tok.cy, count:1, cy: tok.cy, height: tok.h, text:(tok.text||'').trim() };
      }
    }
    if(current) groups.push(current);
    return groups.map((row,idx)=>{
      const next=groups[idx+1];
      const rowTop=Math.min(...row.tokens.map(t=>t.y));
      const rowBottom=Math.max(...row.tokens.map(t=>t.y + t.h));
      const rowHeight=Math.max(rowBottom - rowTop, row.height, 6);
      let y0=rowTop;
      let y1=rowBottom;
      const nextTop = next ? Math.min(...next.tokens.map(t=>t.y)) : Infinity;
      if(Number.isFinite(nextTop)){
        const boundary=(rowBottom + nextTop)/2;
        if(Number.isFinite(boundary)){
          y1 = Math.max(rowBottom, Math.min(boundary, nextTop));
        }
      }
      const maxY1 = Number.isFinite(nextTop) ? Math.max(rowBottom, Math.min(nextTop, pageHeight)) : pageHeight;
      const minBand=Math.max(rowHeight,8);
      if(y1 - y0 < minBand){
        y1 = Math.min(maxY1, y0 + minBand);
      }
      y0=Math.max(0, Math.min(y0, pageHeight));
      y1=Math.max(y0 + 1, Math.min(y1, pageHeight));
      if(y1 <= y0){
        y0=Math.max(0,rowTop);
        y1=Math.max(y0 + 1, Math.min(pageHeight,rowBottom || (rowTop + rowHeight)));
      }
      if(!Number.isFinite(nextTop)){
        y1 = pageHeight;
      }
      return { index:idx, y0, y1, cy:row.cy, height:rowHeight, text:row.text.trim(), tokens:row.tokens };
    });
  }

  function tokensForCell(desc, band, pageTokens){
    const headerLimit = desc.headerBottom + desc.headerPad;
    const y0 = band.y0;
    const y1 = band.y1;
    const expectedLeft = Number.isFinite(desc.expectedLeft) ? desc.expectedLeft : null;
    const expectedRight = Number.isFinite(desc.expectedRight) ? desc.expectedRight : null;
    const expectedCenter = Number.isFinite(desc.expectedCenter)
      ? desc.expectedCenter
      : (Number.isFinite(expectedLeft) && Number.isFinite(expectedRight) ? (expectedLeft + expectedRight) / 2 : null);
    const expectedWidth = Number.isFinite(desc.expectedWidth) ? desc.expectedWidth : (Number.isFinite(expectedLeft) && Number.isFinite(expectedRight) ? Math.max(0, expectedRight - expectedLeft) : null);
    const tolerance = Number.isFinite(desc.feraTolerance) ? desc.feraTolerance : null;
    const align = desc.align || 'left';
    const scored=[];
    for(const tok of pageTokens){
      if(tok.page !== desc.page) continue;
      const cx = tok.x + tok.w/2;
      if(cx < desc.x0 - 1 || cx > desc.x1 + 1) continue;
      const cy = tok.y + tok.h/2;
      if(cy <= headerLimit) continue;
      const text=(tok.text||'').trim();
      if(!text) continue;
      const top=tok.y;
      const bottom=tok.y + tok.h;
      const overlap=Math.min(bottom, y1) - Math.max(top, y0);
      const minOverlap=Math.min(tok.h, y1 - y0) * 0.35;
      if(overlap < minOverlap) continue;
      const leftEdge = tok.x;
      const rightEdge = tok.x + tok.w;
      const center = leftEdge + tok.w/2;
      let diff = 0;
      if(align === 'right' && Number.isFinite(expectedRight)){
        diff = Math.abs(rightEdge - expectedRight);
      } else if(align === 'center' && Number.isFinite(expectedCenter)){
        diff = Math.abs(center - expectedCenter);
      } else if(Number.isFinite(expectedLeft)){
        diff = Math.abs(leftEdge - expectedLeft);
      } else if(Number.isFinite(expectedRight)){
        diff = Math.abs(rightEdge - expectedRight);
      } else if(Number.isFinite(expectedCenter)){
        diff = Math.abs(center - expectedCenter);
      }
      const tokenWithCy = { ...tok, cy };
      scored.push({ token: tokenWithCy, diff });
    }
    scored.sort((a,b)=> (a.token.x - b.token.x) || (a.token.y - b.token.y));
    let feraOk = true;
    let feraReason = null;
    let bestDiff = null;
    let tokensOut = scored.map(s => s.token);
    if(tolerance && scored.length){
      const within = scored.filter(s => s.diff <= tolerance);
      if(within.length){
        within.sort((a,b)=> a.diff - b.diff || a.token.y - b.token.y || a.token.x - b.token.x);
        bestDiff = within[0].diff;
        tokensOut = within.map(s => s.token);
      } else {
        const sortedByDiff = scored.slice().sort((a,b)=> a.diff - b.diff || a.token.y - b.token.y || a.token.x - b.token.x);
        bestDiff = sortedByDiff[0]?.diff ?? null;
        feraOk = false;
        feraReason = 'fera_out_of_tolerance';
        const keep = Math.max(1, Math.ceil(Math.min(3, sortedByDiff.length) / 2));
        tokensOut = sortedByDiff.slice(0, keep).map(s => s.token);
      }
    }
    if(tokensOut.length){
      tokensOut.sort((a,b)=> a.x - b.x || a.y - b.y || a.w - b.w);
    }
    return {
      tokens: tokensOut,
      feraOk,
      feraReason,
      feraTolerance: tolerance,
      feraBestDiff: bestDiff,
      feraExpected: {
        left: expectedLeft,
        right: expectedRight,
        center: expectedCenter,
        width: expectedWidth,
        align
      }
    };
  }

  return {
    normalizeGuardList,
    buildRowBands,
    tokensForCell
  };
});
