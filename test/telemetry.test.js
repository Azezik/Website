const assert = require('assert');

// Minimal localStorage mock
const store = {};
global.localStorage = {
  getItem(k){ return store[k] ?? null; },
  setItem(k, v){ store[k] = String(v); },
  removeItem(k){ delete store[k]; },
  clear(){ Object.keys(store).forEach(k => delete store[k]); }
};

const DataTelemetry = require('../js/data/telemetry.js');

async function main(){
  // Test 1: increment counters
  {
    DataTelemetry.reset();
    DataTelemetry.increment('firestoreWrites');
    DataTelemetry.increment('firestoreWrites');
    DataTelemetry.increment('firestoreReads', 5);
    const snap = DataTelemetry.getSnapshot();
    assert.strictEqual(snap.counters.firestoreWrites, 2);
    assert.strictEqual(snap.counters.firestoreReads, 5);
  }

  // Test 2: record payload sizes
  {
    DataTelemetry.reset();
    DataTelemetry.recordPayloadSize('wizards', 'wizards/abc', 1024);
    DataTelemetry.recordPayloadSize('fields', 'fields/xyz', 256);
    const snap = DataTelemetry.getSnapshot();
    assert.strictEqual(snap.recentPayloadSizes.length, 2);
    assert.strictEqual(snap.recentPayloadSizes[0].sizeBytes, 1024);
  }

  // Test 3: record errors
  {
    localStorage.clear();
    DataTelemetry.recordError('test-category', new Error('test error'), { path: '/test' });
    const buffer = DataTelemetry.getErrorBuffer();
    assert.strictEqual(buffer.length, 1);
    assert.strictEqual(buffer[0].category, 'test-category');
    assert.strictEqual(buffer[0].message, 'test error');
    assert.strictEqual(buffer[0].context.path, '/test');
  }

  // Test 4: clear error buffer
  {
    DataTelemetry.clearErrorBuffer();
    const buffer = DataTelemetry.getErrorBuffer();
    assert.strictEqual(buffer.length, 0);
  }

  // Test 5: snapshot has timestamp
  {
    const snap = DataTelemetry.getSnapshot();
    assert.ok(snap.timestamp > 0);
  }

  // Test 6: reset clears everything
  {
    DataTelemetry.increment('cacheHits', 10);
    DataTelemetry.recordPayloadSize('x', 'x', 100);
    DataTelemetry.reset();
    const snap = DataTelemetry.getSnapshot();
    assert.strictEqual(snap.counters.cacheHits, 0);
    assert.strictEqual(snap.recentPayloadSizes.length, 0);
  }

  console.log('DataTelemetry tests passed.');
}

main();
