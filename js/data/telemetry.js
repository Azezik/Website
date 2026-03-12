(function(root){
  'use strict';

  const TELEMETRY_BUFFER_KEY = 'wrokit.telemetry.buffer';
  const MAX_BUFFER_SIZE = 100;

  const counters = {
    firestoreWrites: 0,
    firestoreReads: 0,
    firestoreWriteFailures: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSets: 0,
    cacheEvictions: 0,
    migrationAttempts: 0,
    migrationSuccesses: 0,
    migrationFailures: 0,
    writeQueueFlushes: 0,
    writeQueueRetries: 0,
    batchedWrites: 0
  };

  const payloadSizes = [];

  function recordPayloadSize(collection, docPath, sizeBytes){
    payloadSizes.push({
      collection,
      docPath,
      sizeBytes,
      timestamp: Date.now()
    });
    if(payloadSizes.length > MAX_BUFFER_SIZE){
      payloadSizes.splice(0, payloadSizes.length - MAX_BUFFER_SIZE);
    }
  }

  function increment(counterName, amount){
    if(counterName in counters){
      counters[counterName] += (amount || 1);
    }
  }

  function recordError(category, error, context){
    const entry = {
      category,
      message: error?.message || String(error),
      code: error?.code || null,
      context: context || null,
      timestamp: Date.now()
    };
    try {
      const raw = localStorage.getItem(TELEMETRY_BUFFER_KEY);
      const buffer = raw ? JSON.parse(raw) : [];
      buffer.push(entry);
      if(buffer.length > MAX_BUFFER_SIZE){
        buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
      }
      localStorage.setItem(TELEMETRY_BUFFER_KEY, JSON.stringify(buffer));
    } catch(err){
      // telemetry should never break the app
    }
    console.warn(`[telemetry][${category}]`, entry.message, context || '');
  }

  function getSnapshot(){
    return {
      counters: { ...counters },
      recentPayloadSizes: payloadSizes.slice(-20),
      timestamp: Date.now()
    };
  }

  function getErrorBuffer(){
    try {
      const raw = localStorage.getItem(TELEMETRY_BUFFER_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch{ return []; }
  }

  function clearErrorBuffer(){
    try { localStorage.removeItem(TELEMETRY_BUFFER_KEY); } catch{}
  }

  function reset(){
    Object.keys(counters).forEach(k => { counters[k] = 0; });
    payloadSizes.length = 0;
  }

  const DataTelemetry = {
    increment,
    recordPayloadSize,
    recordError,
    getSnapshot,
    getErrorBuffer,
    clearErrorBuffer,
    reset
  };

  if(typeof module === 'object' && module.exports){
    module.exports = DataTelemetry;
  } else {
    root.DataTelemetry = DataTelemetry;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
