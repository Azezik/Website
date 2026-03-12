(function(root){
  'use strict';

  const DEFAULT_DEBOUNCE_MS = 2000;
  const DEFAULT_MAX_BATCH_SIZE = 10;
  const DEFAULT_MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 1000;

  /**
   * WriteQueue: debounced, batched writes with retry/backoff.
   *
   * Usage:
   *   const queue = new WriteQueue({ flushFn, debounceMs, maxBatchSize });
   *   queue.enqueue({ path: 'wizards/abc', data: {...} });
   *   // flushFn is called with array of pending ops after debounce
   */
  class WriteQueue {
    constructor(opts = {}){
      this._flushFn = opts.flushFn || (async () => {});
      this._debounceMs = opts.debounceMs || DEFAULT_DEBOUNCE_MS;
      this._maxBatchSize = opts.maxBatchSize || DEFAULT_MAX_BATCH_SIZE;
      this._maxRetries = opts.maxRetries || DEFAULT_MAX_RETRIES;
      this._telemetry = opts.telemetry || null;
      this._pending = new Map(); // path -> { path, data, mergedAt }
      this._timer = null;
      this._flushing = false;
      this._flushPromise = null;
      this._onError = opts.onError || null;
    }

    enqueue(op){
      if(!op || !op.path) return;
      const existing = this._pending.get(op.path);
      if(existing){
        // Merge: newer data wins for same path
        existing.data = op.data;
        existing.mergedAt = Date.now();
        existing.mergeCount = (existing.mergeCount || 0) + 1;
      } else {
        this._pending.set(op.path, {
          path: op.path,
          data: op.data,
          enqueuedAt: Date.now(),
          mergedAt: Date.now(),
          mergeCount: 0,
          collection: op.collection || null,
          docId: op.docId || null,
          type: op.type || 'set' // 'set' | 'update' | 'delete'
        });
      }
      this._scheduleFlush();
    }

    _scheduleFlush(){
      if(this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this.flush(), this._debounceMs);
    }

    async flush(){
      if(this._timer){ clearTimeout(this._timer); this._timer = null; }
      if(this._flushing){
        // Wait for current flush then re-flush if more pending
        await this._flushPromise;
        if(this._pending.size > 0) return this.flush();
        return;
      }
      if(this._pending.size === 0) return;

      this._flushing = true;
      const ops = [];
      const keys = [...this._pending.keys()];
      const batchKeys = keys.slice(0, this._maxBatchSize);
      for(const key of batchKeys){
        ops.push(this._pending.get(key));
        this._pending.delete(key);
      }

      this._flushPromise = this._executeWithRetry(ops);
      try {
        await this._flushPromise;
        if(this._telemetry){
          this._telemetry.increment('writeQueueFlushes');
          this._telemetry.increment('batchedWrites', ops.length);
        }
      } catch(err){
        // Re-enqueue failed ops for retry at next flush
        for(const op of ops){
          op._retryCount = (op._retryCount || 0) + 1;
          if(op._retryCount <= this._maxRetries){
            this._pending.set(op.path, op);
          } else {
            if(this._telemetry) this._telemetry.recordError('write-queue-exhausted', err, { path: op.path });
            if(this._onError) this._onError(err, op);
          }
        }
        if(this._pending.size > 0) this._scheduleFlush();
      } finally {
        this._flushing = false;
        this._flushPromise = null;
        // Flush remaining if any
        if(this._pending.size > 0) this._scheduleFlush();
      }
    }

    async _executeWithRetry(ops, attempt = 0){
      try {
        await this._flushFn(ops);
      } catch(err){
        if(attempt < this._maxRetries){
          const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
          if(this._telemetry) this._telemetry.increment('writeQueueRetries');
          await new Promise(r => setTimeout(r, delay));
          return this._executeWithRetry(ops, attempt + 1);
        }
        throw err;
      }
    }

    get pendingCount(){
      return this._pending.size;
    }

    get isFlushing(){
      return this._flushing;
    }

    destroy(){
      if(this._timer){ clearTimeout(this._timer); this._timer = null; }
      this._pending.clear();
    }
  }

  if(typeof module === 'object' && module.exports){
    module.exports = WriteQueue;
  } else {
    root.WriteQueue = WriteQueue;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
