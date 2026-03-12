const assert = require('assert');
const WriteQueue = require('../js/data/write-queue.js');

async function main(){
  // Test 1: basic enqueue and flush
  {
    const flushed = [];
    const queue = new WriteQueue({
      debounceMs: 10,
      flushFn: async (ops) => { flushed.push(...ops); }
    });

    queue.enqueue({ path: 'a/b', data: { x: 1 } });
    queue.enqueue({ path: 'c/d', data: { y: 2 } });
    assert.strictEqual(queue.pendingCount, 2);

    await queue.flush();
    assert.strictEqual(flushed.length, 2);
    assert.strictEqual(queue.pendingCount, 0);
    queue.destroy();
  }

  // Test 2: deduplication by path (newer data wins)
  {
    const flushed = [];
    const queue = new WriteQueue({
      debounceMs: 50,
      flushFn: async (ops) => { flushed.push(...ops); }
    });

    queue.enqueue({ path: 'same/path', data: { version: 1 } });
    queue.enqueue({ path: 'same/path', data: { version: 2 } });
    assert.strictEqual(queue.pendingCount, 1, 'same path should merge');

    await queue.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].data.version, 2, 'newer data should win');
    queue.destroy();
  }

  // Test 3: retry on failure
  {
    let attempts = 0;
    const queue = new WriteQueue({
      debounceMs: 10,
      maxRetries: 2,
      flushFn: async (ops) => {
        attempts++;
        if(attempts < 3) throw new Error('transient');
      }
    });

    queue.enqueue({ path: 'a/b', data: { x: 1 } });
    await queue.flush();
    assert.ok(attempts >= 2, 'should retry on failure');
    queue.destroy();
  }

  // Test 4: max batch size respected
  {
    const flushedBatches = [];
    const queue = new WriteQueue({
      debounceMs: 10,
      maxBatchSize: 2,
      flushFn: async (ops) => { flushedBatches.push(ops.length); }
    });

    queue.enqueue({ path: 'a', data: {} });
    queue.enqueue({ path: 'b', data: {} });
    queue.enqueue({ path: 'c', data: {} });

    await queue.flush();
    assert.strictEqual(flushedBatches[0], 2, 'first batch should be maxBatchSize');
    // Remaining item gets flushed by the re-schedule
    await new Promise(r => setTimeout(r, 50));
    await queue.flush();
    queue.destroy();
  }

  // Test 5: telemetry integration
  {
    const counters = { writeQueueFlushes: 0, batchedWrites: 0 };
    const telemetry = {
      increment(name, amount){ counters[name] = (counters[name] || 0) + (amount || 1); },
      recordError(){}
    };
    const queue = new WriteQueue({
      debounceMs: 10,
      telemetry,
      flushFn: async () => {}
    });

    queue.enqueue({ path: 'a', data: {} });
    queue.enqueue({ path: 'b', data: {} });
    await queue.flush();
    assert.strictEqual(counters.writeQueueFlushes, 1);
    assert.strictEqual(counters.batchedWrites, 2);
    queue.destroy();
  }

  // Test 6: destroy clears pending
  {
    const queue = new WriteQueue({
      debounceMs: 1000,
      flushFn: async () => {}
    });
    queue.enqueue({ path: 'a', data: {} });
    assert.strictEqual(queue.pendingCount, 1);
    queue.destroy();
    assert.strictEqual(queue.pendingCount, 0);
  }

  console.log('WriteQueue tests passed.');
}

main();
