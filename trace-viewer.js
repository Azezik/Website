(function(){
  const traces = window.debugTraces?.traces || [];
  const els = {
    docFilter: document.getElementById('docFilter'),
    fieldFilter: document.getElementById('fieldFilter'),
    stageFilter: document.getElementById('stageFilter'),
    thumbs: document.getElementById('thumbs'),
    detailImg: document.getElementById('detailImg'),
    ovCanvas: document.getElementById('ovCanvas'),
    eventJson: document.getElementById('eventJson'),
    copyBtn: document.getElementById('copyTraceBtn'),
    ovSel: document.getElementById('ovSel'),
    ovTok: document.getElementById('ovTok'),
    ovAnc: document.getElementById('ovAnc'),
    ovHeat: document.getElementById('ovHeat'),
    verboseToggle: document.getElementById('verboseToggle'),
    copyEventBtn: document.getElementById('copyEventBtn'),
    copySummaryBtn: document.getElementById('copySummaryBtn'),
    eventSummary: document.getElementById('eventSummary'),
    ovHints: document.getElementById('ovHints')
  };
  function scaledRect(box){
    const img=els.detailImg;
    if(!img.naturalWidth||!img.naturalHeight) return null;
    const scaleX=img.clientWidth/img.naturalWidth;
    const scaleY=img.clientHeight/img.naturalHeight;
    const x=box.x||box.x0||0, y=box.y||box.y0||0;
    const w=box.w||(box.x1?box.x1-box.x0:0), h=box.h||(box.y1?box.y1-box.y0:0);
    return { x:x*scaleX, y:y*scaleY, w:w*scaleX, h:h*scaleY };
  }
  function populate(sel, items){
    const opt = document.createElement('option');
    opt.value=''; opt.textContent='(all)';
    sel.appendChild(opt);
    items.forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o); });
  }
  function initFilters(){
    populate(els.docFilter, Array.from(new Set(traces.map(t=>t.spanKey.docId))));
    populate(els.fieldFilter, Array.from(new Set(traces.map(t=>t.spanKey.fieldKey))));
    populate(els.stageFilter, Array.from(new Set(traces.flatMap(t=>t.events.map(e=>e.stage)))));
    els.docFilter.onchange=renderThumbs;
    els.fieldFilter.onchange=renderThumbs;
    els.stageFilter.onchange=renderThumbs;
  }
  function renderThumbs(){
    const doc=els.docFilter.value;
    const field=els.fieldFilter.value;
    const stage=els.stageFilter.value;
    els.thumbs.innerHTML='';
    traces.forEach(t=>{
      if(doc && t.spanKey.docId!==doc) return;
      if(field && t.spanKey.fieldKey!==field) return;
      t.events.forEach((ev,i)=>{
        if(stage && ev.stage!==stage) return;
        if(!ev.artifact) return;
        const img=document.createElement('img');
        img.src=ev.artifact;
        img.className='thumb';
        img.dataset.traceId=t.traceId;
        img.dataset.index=i;
        img.onclick=()=>showEvent(t.traceId,i,img);
        els.thumbs.appendChild(img);
      });
    });
  }
  function showEvent(traceId,index,thumb){
    const trace=debugTraces.get(traceId); if(!trace) return;
    const ev=trace.events[index];
    els.detailImg.onload=()=>{ resizeCanvas(); drawOverlays(ev); };
    els.detailImg.src=ev.artifact||'';
    els.eventJson.textContent=JSON.stringify(ev,null,2);
    els.eventSummary.textContent=formatEventSummary(ev, !!els.verboseToggle?.checked);
    [...els.thumbs.querySelectorAll('img')].forEach(im=>im.classList.remove('selected'));
    if(thumb) thumb.classList.add('selected');
    els.copyBtn.onclick=()=>copyTraceJson(traceId);
    if(els.copyEventBtn) els.copyEventBtn.onclick=()=>copyText(JSON.stringify(ev,null,2));
    if(els.copySummaryBtn) els.copySummaryBtn.onclick=()=>copyText(els.eventSummary.textContent);
    if(els.verboseToggle){
      els.verboseToggle.onchange=()=>{ els.eventSummary.textContent=formatEventSummary(ev, !!els.verboseToggle.checked); };
    }
  }
  function resizeCanvas(){
    const w=els.detailImg.naturalWidth;
    const h=els.detailImg.naturalHeight;
    els.ovCanvas.width=w;
    els.ovCanvas.height=h;
    els.ovCanvas.style.width=els.detailImg.width+'px';
    els.ovCanvas.style.height=els.detailImg.height+'px';
  }
  function drawOverlays(ev){
    const ctx=els.ovCanvas.getContext('2d');
    ctx.clearRect(0,0,els.ovCanvas.width,els.ovCanvas.height);
    if(els.ovHints){ els.ovHints.innerHTML=''; }
    if(els.ovSel.checked){
      const b=ev.input?.boxPx||ev.input?.normBox||ev.output?.rect;
      if(b){
        const w=els.ovCanvas.width;
        const h=els.ovCanvas.height;
        let x=b.x||b.x0||(b.x0n*w)||0;
        let y=b.y||b.y0||(b.y0n*h)||0;
        let bw=b.w||(b.wN*w)||b.sw||0;
        let bh=b.h||(b.hN*h)||b.sh||0;
        const expanded = wasExpanded(ev);
        ctx.strokeStyle= expanded ? '#5bc0ff' : 'lime'; ctx.lineWidth= expanded ? 3 : 2;
        if(expanded){ ctx.setLineDash([6,4]); }
        ctx.strokeRect(x,y,bw,bh);
        if(expanded){ ctx.setLineDash([]); }
      }
    }
    if(els.ovTok.checked && ev.output?.tokens){
      ev.output.tokens.forEach(tok=>{
        const b=tok.box||tok;
        const x=b.x||b.x0||0, y=b.y||b.y0||0;
        const w=b.w||(b.x1?b.x1-b.x0:0), h=b.h||(b.y1?b.y1-b.y0:0);
        if(els.ovHeat.checked){
          const conf=tok.conf||tok.confidence||0;
          const col=`rgba(${Math.round((1-conf)*255)},${Math.round(conf*255)},0,0.3)`;
          ctx.fillStyle=col; ctx.fillRect(x,y,w,h);
        }
        ctx.strokeStyle='yellow';
        ctx.strokeRect(x,y,w,h);
        renderHintBox(b,{
          title:`Token: ${cleanTokenText(tok.text||tok.value||tok.raw||'')}${tok.conf||tok.confidence?`\nconf: ${Math.round((tok.conf||tok.confidence)*100)}%`:''}`,
          type:'tok'
        });
      });
    }
    if(els.ovAnc.checked && ev.output?.anchors){
      ctx.strokeStyle='red';
      ev.output.anchors.forEach(a=>{
        const b=a.box||a;
        const x=b.x||b.x0||0, y=b.y||b.y0||0;
        const w=b.w||(b.x1?b.x1-b.x0:0), h=b.h||(b.y1?b.y1-b.y0:0);
        ctx.strokeRect(x,y,w,h);
        renderHintBox(b,{
          title:`Anchor: ${cleanTokenText(a.text||a.label||'')}`,
          type:'anc'
        });
      });
    }
  }
  ['ovSel','ovTok','ovAnc','ovHeat'].forEach(id=>{
    els[id].addEventListener('change',()=>{
      const sel=els.thumbs.querySelector('img.selected');
      if(!sel) return;
      const tr=sel.dataset.traceId;
      const idx=parseInt(sel.dataset.index);
      const ev=debugTraces.get(tr).events[idx];
      drawOverlays(ev);
    });
  });
  function renderHintBox(box,{title,type}){
    if(!els.ovHints) return;
    const rect = scaledRect(box);
    if(!rect) return;
    const d=document.createElement('div');
    d.className=`ov-hint ov-${type}`;
    d.style.left=`${rect.x}px`; d.style.top=`${rect.y}px`;
    d.style.width=`${rect.w}px`; d.style.height=`${rect.h}px`;
    d.title=title;
    els.ovHints.appendChild(d);
    const img=els.detailImg;
    els.ovHints.style.width=`${img.clientWidth}px`;
    els.ovHints.style.height=`${img.clientHeight}px`;
  }
  function cleanTokenText(txt){
    return String(txt||'').replace(/\s+/g,' ').trim();
  }
  function copyText(txt){
    if(window.navigator?.clipboard?.writeText) window.navigator.clipboard.writeText(txt);
    else {
      const ta=document.createElement('textarea');
      ta.value=txt; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); }catch{}
      document.body.removeChild(ta);
    }
  }
  function wasExpanded(ev){
    const e=ev.input||{};
    if(e.expanded || e.bboxExpanded) return true;
    if(typeof e.expansionLevel==='number') return e.expansionLevel>0;
    if(e.expansion?.level!=null) return e.expansion.level>0 || !!e.expansion.used;
    return false;
  }
  function summarizeBox(ev){
    const boxes=[ev.bbox?.pixel||ev.input?.boxPx||null, ev.bbox?.normalized||ev.input?.normBox||null].filter(Boolean);
    if(!boxes.length) return 'n/a';
    return boxes.map(b=>{
      const parts=['x','y','w','h'].map(k=>b[k]!=null?`${k}:${Math.round(b[k]*100)/100}`:null).filter(Boolean);
      return `{${parts.join(', ')}}`;
    }).join(' | ');
  }
  function summarizeCounts(ev){
    const c=ev.counts || ev.input?.counts || ev.output?.counts || {};
    const tok=c.tokens!=null?`tokens:${c.tokens}`:null;
    const anc=c.anchors!=null?`anchors:${c.anchors}`:null;
    const scans=c.scans!=null?`scans:${c.scans}`:null;
    return [tok,anc,scans].filter(Boolean).join(', ') || 'n/a';
  }
  function summarizeOutput(ev){
    const out=ev.output||{};
    const val = out.value ?? out.text ?? out.result ?? out.selection ?? out.string ?? null;
    const conf = out.confidence ?? ev.confidence;
    const anchors = Array.isArray(out.anchors)?out.anchors.length:null;
    const tokens = Array.isArray(out.tokens)?out.tokens.length:null;
    return {
      value: val!=null?String(val):'n/a',
      confidence: conf!=null?`${Math.round(conf*100)/100}`:'n/a',
      anchors, tokens
    };
  }
  function formatEventSummary(ev, verbose=false){
    const lines=[];
    const totalStr = ev.stepTotal!=null ? ` of ${ev.stepTotal}` : '';
    lines.push('Static Debug Log');
    lines.push(`Stage: ${ev.stepNumber!=null?`#${ev.stepNumber}${totalStr} `:''}${ev.stageLabel||ev.stage||'unknown'} (${ev.stage||'n/a'})`);
    lines.push(`Duration: ${Math.round((ev.durationMs||0)*10)/10} ms`);
    lines.push(`Doc: ${ev.docMeta?.docId||'doc'} page ${ev.docMeta?.pageIndex ?? 0}${ev.docMeta?.pageLabel?` (${ev.docMeta.pageLabel})`:''}`);
    lines.push(`Field: ${ev.fieldMeta?.fieldKey||'n/a'}${ev.fieldMeta?.fieldLabel?` [${ev.fieldMeta.fieldLabel}]`:''}`);
    lines.push('');
    lines.push('Input');
    lines.push(`- BBox: ${summarizeBox(ev)}`);
    lines.push(`- Expanded: ${wasExpanded(ev) ? 'yes' : 'no'}`);
    const c=ev.counts||ev.input?.counts||{};
    lines.push(`- Counts: ${summarizeCounts(ev)}`);
    const tokIn = Array.isArray(ev.input?.tokens)?ev.input.tokens.length:null;
    lines.push(`- Tokens captured: ${tokIn!=null?tokIn:'n/a'}`);
    lines.push('');
    const out=summarizeOutput(ev);
    lines.push('Output');
    lines.push(`- Value: ${out.value}`);
    lines.push(`- Confidence: ${out.confidence}`);
    lines.push(`- Tokens returned: ${out.tokens!=null?out.tokens:'n/a'}`);
    lines.push(`- Anchors: ${out.anchors!=null?out.anchors:'n/a'}`);
    if(ev.output?.warnings||ev.output?.errors){ lines.push(''); }
    const warns=[...(ev.warnings||[]),(ev.output?.warnings||[])].flat().filter(Boolean);
    const errs=[...(ev.errors||[]),(ev.output?.errors||[])].flat().filter(Boolean);
    if(warns.length){ lines.push('Warnings:'); warns.forEach(w=>lines.push(`- ${w.message||w.code||String(w)}`)); }
    if(errs.length){ lines.push('Errors:'); errs.forEach(e=>lines.push(`- ${e.message||e.code||String(e)}`)); }
    if(verbose){
      lines.push('');
      if(ev.notes) lines.push(`Notes: ${cleanTokenText(ev.notes)}`);
      if(ev.heuristics) lines.push(`Heuristics: ${JSON.stringify(ev.heuristics)}`);
      if(ev.ocrConfig) lines.push(`OCR: ${JSON.stringify(ev.ocrConfig)}`);
      if(ev.input?.anchors) lines.push(`Input anchors: ${ev.input.anchors.length}`);
      if(ev.input?.expansion) lines.push(`Expansion detail: ${JSON.stringify(ev.input.expansion)}`);
      if(ev.timing) lines.push(`Timing: ${JSON.stringify(ev.timing)}`);
    }
    return lines.join('\n');
  }
  initFilters();
  renderThumbs();
})();
