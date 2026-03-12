const assert = require('assert');

// Minimal localStorage mock for Node.js
const store = {};
global.localStorage = {
  getItem(k){ return store[k] ?? null; },
  setItem(k, v){ store[k] = String(v); },
  removeItem(k){ delete store[k]; },
  clear(){ Object.keys(store).forEach(k => delete store[k]); },
  get length(){ return Object.keys(store).length; },
  key(i){ return Object.keys(store)[i] ?? null; }
};

const LocalCacheAdapter = require('../js/data/local-cache.js');

async function main(){
  // Test 1: basic get/set
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    cache.set('profile:abc', { name: 'test' });
    const result = cache.get('profile:abc');
    assert.deepStrictEqual(result, { name: 'test' });
  }

  // Test 2: TTL expiration
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 1 }); // 1ms TTL
    cache.set('key', { val: 1 });
    await new Promise(r => setTimeout(r, 10));
    const result = cache.get('key');
    assert.strictEqual(result, null, 'expired entries should return null');
  }

  // Test 3: LRU eviction on size limit
  {
    localStorage.clear();
    // Each item is 116 bytes. Budget 230 fits 2 but not 3 (3*116=348 > 230).
    const cache = new LocalCacheAdapter({ maxBytes: 230, ttlMs: 60000 });
    cache.set('a', { d: 'x'.repeat(50) });
    cache.set('b', { d: 'y'.repeat(50) });
    // Access 'a' to make it more recent
    cache.get('a');
    // Adding 'c' should trigger eviction of least-recently-used ('b')
    cache.set('c', { d: 'z'.repeat(50) });
    // 'b' should be evicted (least recently accessed)
    const bResult = cache.get('b');
    assert.strictEqual(bResult, null, 'LRU item should be evicted');
  }

  // Test 4: remove
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    cache.set('key', { val: 1 });
    cache.remove('key');
    const result = cache.get('key');
    assert.strictEqual(result, null, 'removed item should return null');
  }

  // Test 5: cache stats
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    cache.set('a', { x: 1 });
    cache.set('b', { y: 2 });
    const stats = cache.getCacheStats();
    assert.strictEqual(stats.entryCount, 2);
    assert.ok(stats.totalBytes > 0);
    assert.strictEqual(stats.maxBytes, 100000);
  }

  // Test 6: clear
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    cache.set('a', { x: 1 });
    cache.set('b', { y: 2 });
    cache.clear();
    assert.strictEqual(cache.getCacheStats().entryCount, 0);
    assert.strictEqual(cache.get('a'), null);
  }

  // Test 7: telemetry tracking
  {
    localStorage.clear();
    const counters = { cacheHits: 0, cacheMisses: 0, cacheSets: 0, cacheEvictions: 0 };
    const telemetry = {
      increment(name){ counters[name] = (counters[name] || 0) + 1; }
    };
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000, telemetry });
    cache.set('a', { x: 1 });
    assert.strictEqual(counters.cacheSets, 1);
    cache.get('a');
    assert.strictEqual(counters.cacheHits, 1);
    cache.get('nonexistent');
    assert.strictEqual(counters.cacheMisses, 1);
    cache.remove('a');
    assert.strictEqual(counters.cacheEvictions, 1);
  }

  console.log('LocalCacheAdapter tests passed.');
}

main();
