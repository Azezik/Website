(function(global){
  function uuid(){
    if(global.crypto?.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
      const r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);
      return v.toString(16);
    });
  }
  class TraceStore{
    constructor(max=25){ this.max=max; this.traces=[]; }
    start(spanKey){
      const traceId=uuid();
      const t={traceId, spanKey, events:[], started:Date.now(), _last:performance.now()};
      this.traces.push(t);
      if(this.traces.length>this.max) this.traces.shift();
      return traceId;
    }
    add(traceId, stage, {input={},output={},warnings=[],errors=[],durationMs,artifact}={}){
      const t=this.traces.find(tr=>tr.traceId===traceId); if(!t) return;
      const now=performance.now();
      const dur=durationMs!=null?durationMs:now-t._last;
      t._last=now;
      const ev={traceId, spanKey:t.spanKey, stage, ts:Date.now(), durationMs:dur, input, output, warnings, errors};
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
    global.debugTraces.add(id, stage, { output: payload });
  };
})(window);
