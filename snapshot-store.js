(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnapshotStore = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  function estimateDataUrlBytes(dataUrl){
    if(!dataUrl || typeof dataUrl !== 'string') return 0;
    const commaIdx = dataUrl.indexOf(',');
    const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    return Math.ceil((b64.length || 0) * 3 / 4);
  }

  class SnapshotStore {
    constructor(opts = {}){
      this.map = {};
      this.maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 2_500_000;
      this.maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : 16;
    }
    get(fileId){
      return this.map[fileId] || null;
    }
    set(fileId, manifest){
      if(!fileId || !manifest) return null;
      this.map[fileId] = manifest;
      return manifest;
    }
    reset(fileId){ if(fileId) delete this.map[fileId]; }
    upsertPage(fileId, pageEntry){
      if(!fileId || !pageEntry || !pageEntry.pageNumber) return null;
      const manifest = this.map[fileId] || { id: `${fileId}:snap`, fileId, createdAtISO: new Date().toISOString(), overlays: {}, pages: [] };
      this.map[fileId] = manifest;
      if(this.maxPages && manifest.pages.length >= this.maxPages && !manifest.pages.some(p => p.pageNumber === pageEntry.pageNumber)){
        return null;
      }
      const entry = { ...pageEntry };
      const thumbBytes = estimateDataUrlBytes(entry.thumbUrl || entry.dataUrl || '');
      entry.byteLength = thumbBytes;
      if(this.maxBytes && estimateDataUrlBytes(entry.dataUrl || '') > this.maxBytes){
        entry.dataUrl = null;
        entry.tooLarge = true;
      }
      const idx = manifest.pages.findIndex(p => p.pageNumber === entry.pageNumber);
      if(idx >= 0) manifest.pages[idx] = { ...manifest.pages[idx], ...entry };
      else manifest.pages.push(entry);
      return entry;
    }
  }

  SnapshotStore.estimateDataUrlBytes = estimateDataUrlBytes;
  return SnapshotStore;
});
