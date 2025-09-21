(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FieldMap = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  class FieldMap {
    constructor(){ this.map = {}; }
    get(fileId){
      if(!this.map[fileId]) this.map[fileId] = [];
      return this.map[fileId];
    }
    upsert(fileId, rec){
      if(!fileId || !rec || !rec.fieldKey) return;
      const arr = this.get(fileId);
      const idx = arr.findIndex(r => r.fieldKey === rec.fieldKey);
      if(idx < 0){ arr.push(rec); return; }
      const cur = arr[idx];
      const newConf = rec.confidence ?? 0;
      const oldConf = cur.confidence ?? 0;
      if(newConf > oldConf || (newConf === oldConf && (rec.ts || 0) > (cur.ts || 0))){
        arr[idx] = rec;
      }
    }
    clear(fileId){ delete this.map[fileId]; }
  }
  return FieldMap;
});
