(function(root){
  'use strict';

  const CACHE_PREFIX = 'wrokit.cache.';
  const CACHE_INDEX_KEY = 'wrokit.cache._index';
  const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  function estimateStringBytes(str){
    return typeof str === 'string' ? str.length * 2 : 0;
  }

  /**
   * LocalCacheAdapter: localStorage as an LRU cache with TTL and size limits.
   *
   * This is NOT the primary data store — it's a performance cache for
   * recently-accessed data to provide optimistic UI and offline fallback.
   */
  class LocalCacheAdapter {
    constructor(opts = {}){
      this._maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
      this._ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
      this._telemetry = opts.telemetry || null;
      this._index = this._loadIndex();
    }

    _loadIndex(){
      try {
        const raw = localStorage.getItem(CACHE_INDEX_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch{ return {}; }
    }

    _saveIndex(){
      try {
        localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(this._index));
      } catch{
        // Index save failure is non-critical
      }
    }

    _cacheKey(path){
      return CACHE_PREFIX + path;
    }

    get(path){
      const key = this._cacheKey(path);
      const meta = this._index[path];
      if(!meta){
        if(this._telemetry) this._telemetry.increment('cacheMisses');
        return null;
      }
      // TTL check
      if(Date.now() - meta.cachedAt > this._ttlMs){
        this._evict(path);
        if(this._telemetry) this._telemetry.increment('cacheMisses');
        return null;
      }
      try {
        const raw = localStorage.getItem(key);
        if(!raw){
          delete this._index[path];
          this._saveIndex();
          if(this._telemetry) this._telemetry.increment('cacheMisses');
          return null;
        }
        // Update access time for LRU
        meta.lastAccessedAt = Date.now();
        this._saveIndex();
        if(this._telemetry) this._telemetry.increment('cacheHits');
        return JSON.parse(raw);
      } catch(err){
        this._evict(path);
        if(this._telemetry) this._telemetry.increment('cacheMisses');
        return null;
      }
    }

    set(path, data){
      const key = this._cacheKey(path);
      try {
        const serialized = JSON.stringify(data);
        const sizeBytes = estimateStringBytes(serialized);

        // Enforce size limit — evict oldest entries until we fit
        this._ensureSpace(sizeBytes);

        localStorage.setItem(key, serialized);
        this._index[path] = {
          cachedAt: Date.now(),
          lastAccessedAt: Date.now(),
          sizeBytes
        };
        this._saveIndex();
        if(this._telemetry) this._telemetry.increment('cacheSets');
        return true;
      } catch(err){
        // Quota exceeded — evict and retry once
        this._evictOldest();
        try {
          const serialized = JSON.stringify(data);
          localStorage.setItem(key, serialized);
          this._index[path] = {
            cachedAt: Date.now(),
            lastAccessedAt: Date.now(),
            sizeBytes: estimateStringBytes(serialized)
          };
          this._saveIndex();
          if(this._telemetry) this._telemetry.increment('cacheSets');
          return true;
        } catch{
          return false;
        }
      }
    }

    remove(path){
      this._evict(path);
    }

    _evict(path){
      const key = this._cacheKey(path);
      try { localStorage.removeItem(key); } catch{}
      delete this._index[path];
      this._saveIndex();
      if(this._telemetry) this._telemetry.increment('cacheEvictions');
    }

    _ensureSpace(neededBytes){
      let totalBytes = 0;
      for(const meta of Object.values(this._index)){
        totalBytes += (meta.sizeBytes || 0);
      }
      while(totalBytes + neededBytes > this._maxBytes && Object.keys(this._index).length > 0){
        this._evictOldest();
        totalBytes = 0;
        for(const meta of Object.values(this._index)){
          totalBytes += (meta.sizeBytes || 0);
        }
      }
    }

    _evictOldest(){
      let oldestPath = null;
      let oldestTime = Infinity;
      for(const [path, meta] of Object.entries(this._index)){
        const accessTime = meta.lastAccessedAt || meta.cachedAt || 0;
        if(accessTime < oldestTime){
          oldestTime = accessTime;
          oldestPath = path;
        }
      }
      if(oldestPath) this._evict(oldestPath);
    }

    clear(){
      for(const path of Object.keys(this._index)){
        const key = this._cacheKey(path);
        try { localStorage.removeItem(key); } catch{}
      }
      this._index = {};
      this._saveIndex();
    }

    getCacheStats(){
      let totalBytes = 0;
      let entryCount = 0;
      for(const meta of Object.values(this._index)){
        totalBytes += (meta.sizeBytes || 0);
        entryCount++;
      }
      return { totalBytes, entryCount, maxBytes: this._maxBytes };
    }
  }

  if(typeof module === 'object' && module.exports){
    module.exports = LocalCacheAdapter;
  } else {
    root.LocalCacheAdapter = LocalCacheAdapter;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
