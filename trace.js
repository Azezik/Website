(function(global){
  const TRACE_STAGE_PLAN=[
    { stage:'bbox:read', label:'BBox read', required:['input.boxPx','input.normBox','ocrConfig'] },
    { stage:'bbox:expand:pass2', label:'BBox micro-expand', required:['input.boxPx','input.expansion','output.bbox'] },
    { stage:'tokens:rank', label:'Token rank', required:['input.tokens','output.tokens','output.value'] },
    { stage:'columns:merge', label:'Column merge', required:['input.tokens','output.rows','output.columns'] },
    { stage:'arith:check', label:'Arithmetic check', required:['input.lineItems','output.subtotal','output.total'] },
    { stage:'finalize', label:'Finalize', required:['output.value','confidence'] }
  ];
  const TRACE_STAGE_INDEX=new Map(TRACE_STAGE_PLAN.map((item,idx)=>[item.stage,{...item,index:idx,stepTotal:TRACE_STAGE_PLAN.length}]));
  function resolveStageMeta(stage,{stageLabel,stepNumber,stepTotal}){
    const plan=TRACE_STAGE_INDEX.get(stage);
    const total=stepTotal!=null?stepTotal:(plan?plan.stepTotal:null);
    const number=stepNumber!=null?stepNumber:(plan?plan.index+1:null);
    return {
      stageLabel: stageLabel || plan?.label || stage,
      stepNumber: number,
      stepTotal: total,
      stagePlan: plan || null
    };
  }
  function uuid(){
    if(global.crypto?.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
      const r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);
      return v.toString(16);
    });
  }
  function normalizeIssues(list){
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    return arr.map(item=>{
      if(!item) return null;
      if(typeof item === 'string') return { code:'generic', message:item };
      if(item instanceof Error) return { code:item.name || 'error', message:item.message || String(item), details: item.stack || null };
      if(typeof item === 'object') return { code:item.code || 'generic', message:item.message || String(item), details:item.details || item.info || null };
      return { code:'generic', message:String(item) };
    }).filter(Boolean);
  }
  function deriveDocMeta(spanKey){
    if(!spanKey) return { docId:'doc', pageIndex:0 };
    return {
      docId: spanKey.docId || spanKey.doc || spanKey.docID || spanKey.id || 'doc',
      pageIndex: Number.isFinite(spanKey.pageIndex) ? spanKey.pageIndex : 0,
      pageLabel: spanKey.pageLabel || null
    };
  }
  function deriveFieldMeta(spanKey){
    if(!spanKey) return null;
    const fm = {};
    if(spanKey.fieldKey) fm.fieldKey = spanKey.fieldKey;
    if(spanKey.fieldLabel) fm.fieldLabel = spanKey.fieldLabel;
    return Object.keys(fm).length ? fm : null;
  }
  class TraceStore{
    constructor(max=25){ this.max=max; this.traces=[]; }
    start(spanKey){
      const traceId=uuid();
      const t={traceId, spanKey, events:[], started:Date.now(), _last:performance.now(), _lastPlanIndex:-1};
      this.traces.push(t);
      if(this.traces.length>this.max){
        const removed=this.traces.shift();
        const removedKey=_spanKeyKey(removed?.spanKey || {});
        if(_traceMap.get(removedKey)===removed?.traceId){
          _traceMap.delete(removedKey);
        }
      }
      return traceId;
    }
    reset(){ this.traces.length=0; _traceMap.clear(); }
    add(traceId, stage, payload={}){
      const t=this.traces.find(tr=>tr.traceId===traceId); if(!t) return;
      const now=performance.now();
      const {
        input={},
        output,
        warnings=[],
        errors=[],
        durationMs,
        artifact,
        stageLabel,
        stepNumber=null,
        stepTotal=null,
        docMeta,
        fieldMeta,
        bbox=null,
        counts=null,
        ocrConfig=null,
        heuristics=null,
        confidence=null,
        timing=null,
        notes=null,
        inputsSnapshot=null,
        ...legacy
      } = payload;
      const meta = resolveStageMeta(stage,{stageLabel, stepNumber, stepTotal});
      const dur=durationMs!=null?durationMs:now-t._last;
      t._last=now;
      const mergedOutput = output ?? legacy ?? {};
      if(confidence != null && mergedOutput.confidence == null){ mergedOutput.confidence = confidence; }
      const planIndex=meta.stagePlan?.index;
      const inferredStepNumber = planIndex!=null ? planIndex+1 : stepNumber;
      const finalStepNumber = inferredStepNumber!=null ? inferredStepNumber : t.events.length+1;
      if(planIndex!=null && planIndex>t._lastPlanIndex){ t._lastPlanIndex=planIndex; }
      const ev={
        traceId,
        spanKey:t.spanKey,
        stage,
        stageLabel: meta.stageLabel,
        stepNumber: finalStepNumber,
        stepTotal: meta.stepTotal,
        stagePlan: meta.stagePlan,
        ts:Date.now(),
        durationMs:dur,
        docMeta: docMeta || deriveDocMeta(t.spanKey),
        fieldMeta: fieldMeta || deriveFieldMeta(t.spanKey),
        bbox: bbox || null,
        counts: counts || null,
        ocrConfig: ocrConfig || null,
        heuristics: heuristics || null,
        confidence: confidence ?? null,
        timing: timing || null,
        notes: notes || null,
        inputsSnapshot: inputsSnapshot || null,
        input,
        output: mergedOutput,
        warnings: normalizeIssues(warnings),
        errors: normalizeIssues(errors)
      };
      if(artifact) ev.artifact=artifact;
      t.events.push(ev);
      return ev;
    }
    get(traceId){ return this.traces.find(t=>t.traceId===traceId); }
    export(traceId){ const t=this.get(traceId); if(!t) return null; return new Blob([JSON.stringify(t,null,2)],{type:'application/json'}); }
  }
  function exportTraceFile(traceId){
    const blob=debugTraces.export(traceId); if(!blob) return;
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=`trace-${traceId}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function copyTraceJson(traceId){
    const t=debugTraces.get(traceId); if(!t) return;
    const txt=JSON.stringify(t,null,2);
    if(global.navigator?.clipboard?.writeText) global.navigator.clipboard.writeText(txt);
    else {
      const ta=document.createElement('textarea');
      ta.value=txt; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); }catch{}
      document.body.removeChild(ta);
    }
  }
  global.TraceStore=TraceStore;
  global.debugTraces=new TraceStore();
  global.exportTraceFile=exportTraceFile;
  global.copyTraceJson=copyTraceJson;
  const _traceMap=new Map();
  function _spanKeyKey(k){ return `${k?.docId||''}:${k?.pageIndex||0}:${k?.fieldKey||''}`; }
  global.traceEvent=function(spanKey, stage, payload={}){
    if(!global.debugTraces||!spanKey||!stage) return;
    const key=_spanKeyKey(spanKey);
    let id=_traceMap.get(key);
    if(!id){ id=global.debugTraces.start(spanKey); _traceMap.set(key,id); }
    const docMeta = { ...deriveDocMeta(spanKey), ...(payload.docMeta||{}) };
    const baseFieldMeta = deriveFieldMeta(spanKey);
    const fieldMeta = (payload.fieldMeta || baseFieldMeta)
      ? { ...(baseFieldMeta||{}), ...(payload.fieldMeta||{}) }
      : null;
    const inferredBbox = payload.bbox || payload.boxPx || payload.pixelBox || payload.normBox ? {
      pixel: payload.boxPx || payload.pixelBox || null,
      normalized: payload.normBox || null,
      css: payload.cssBox || null
    } : null;
    const enrichedPayload = {
      ...payload,
      docMeta,
      fieldMeta,
      bbox: payload.bbox || inferredBbox,
      inputsSnapshot: payload.inputsSnapshot || (payload.boxPx ? { boxPx: payload.boxPx } : payload.inputsSnapshot)
    };
    global.debugTraces.add(id, stage, enrichedPayload);
  };
})(window);
