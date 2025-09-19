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
    ovHeat: document.getElementById('ovHeat')
  };
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
    [...els.thumbs.querySelectorAll('img')].forEach(im=>im.classList.remove('selected'));
    if(thumb) thumb.classList.add('selected');
    els.copyBtn.onclick=()=>copyTraceJson(traceId);
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
    if(els.ovSel.checked){
      const b=ev.input?.boxPx||ev.input?.normBox||ev.output?.rect;
      if(b){
        const w=els.ovCanvas.width;
        const h=els.ovCanvas.height;
        let x=b.x||b.x0||(b.x0n*w)||0;
        let y=b.y||b.y0||(b.y0n*h)||0;
        let bw=b.w||(b.wN*w)||b.sw||0;
        let bh=b.h||(b.hN*h)||b.sh||0;
        ctx.strokeStyle='lime'; ctx.lineWidth=2;
        ctx.strokeRect(x,y,bw,bh);
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
      });
    }
    if(els.ovAnc.checked && ev.output?.anchors){
      ctx.strokeStyle='red';
      ev.output.anchors.forEach(a=>{
        const b=a.box||a;
        const x=b.x||b.x0||0, y=b.y||b.y0||0;
        const w=b.w||(b.x1?b.x1-b.x0:0), h=b.h||(b.y1?b.y1-b.y0:0);
        ctx.strokeRect(x,y,w,h);
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
  initFilters();
  renderThumbs();
})();
