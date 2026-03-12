const assert = require('assert');

// Minimal localStorage mock
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
const WizardDataService = require('../js/data/wizard-data-service.js');

// Mock FirestoreRepo
function createMockRepo(){
  const data = {};
  return {
    data,
    async getWizard(uid, wizardId){
      return data[`wizards/${wizardId}`] || null;
    },
    async setWizard(uid, wizardId, d){
      data[`wizards/${wizardId}`] = { ...d, wizardId };
    },
    async getLayout(uid, wizardId, layoutId){
      return data[`wizards/${wizardId}/layouts/${layoutId}`] || null;
    },
    async setLayout(uid, wizardId, layoutId, d){
      data[`wizards/${wizardId}/layouts/${layoutId}`] = { ...d, layoutId };
    },
    async getField(uid, wizardId, layoutId, fieldKey){
      return data[`wizards/${wizardId}/layouts/${layoutId}/fields/${fieldKey}`] || null;
    },
    async setField(uid, wizardId, layoutId, fieldKey, d){
      data[`wizards/${wizardId}/layouts/${layoutId}/fields/${fieldKey}`] = { ...d, fieldKey };
    },
    async getMasterDb(uid, wizardId){
      return data[`wizards/${wizardId}/masterDb/current`] || null;
    },
    async setMasterDb(uid, wizardId, entries){
      data[`wizards/${wizardId}/masterDb/current`] = { entries };
    },
    async getProfile(uid){
      return data['meta/profile'] || null;
    },
    async setProfile(uid, d){
      data['meta/profile'] = d;
    },
    async getPatternBundle(uid, wizardId, layoutId){
      return data[`wizards/${wizardId}/patterns/${layoutId}`] || null;
    },
    async setPatternBundle(uid, wizardId, layoutId, patternData){
      data[`wizards/${wizardId}/patterns/${layoutId}`] = { patternData };
    },
    async getChartReady(uid, wizardId){
      return data[`wizards/${wizardId}/chartReady/current`] || null;
    },
    async setChartReady(uid, wizardId, d){
      data[`wizards/${wizardId}/chartReady/current`] = { data: d };
    },
    async getMasterDbRows(uid, wizardId){
      return data[`wizards/${wizardId}/masterDbRows/current`] || null;
    },
    async setMasterDbRows(uid, wizardId, d){
      data[`wizards/${wizardId}/masterDbRows/current`] = d;
    },
    async getTemplates(uid){ return data['templates'] || []; },
    async setTemplates(uid, t){ data['templates'] = t; },
    async getModels(uid){ return data['models'] || []; },
    async setModels(uid, m){ data['models'] = m; },
    async getOcrSegments(uid){ return data['ocrSegments'] || null; },
    async setOcrSegments(uid, s, c){ data['ocrSegments'] = { segmentStore: s, segmentStoreChunks: c }; }
  };
}

async function main(){
  // Test 1: Service not ready before init
  {
    localStorage.clear();
    const svc = new WizardDataService({});
    assert.strictEqual(svc.isReady, false);
  }

  // Test 2: Init makes service ready
  {
    localStorage.clear();
    const svc = new WizardDataService({});
    svc.init('uid123', 'testuser');
    assert.strictEqual(svc.isReady, true);
  }

  // Test 3: Firestore disabled by default, cache fallback works
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    const repo = createMockRepo();
    const svc = new WizardDataService({ firestoreRepo: repo, localCache: cache });
    svc.init('uid123', 'testuser');

    assert.strictEqual(svc.isFirestoreEnabled, false);

    // With Firestore disabled, saves go to cache only
    await svc.saveWizard('wiz1', { docType: 'invoice', displayName: 'Test' });
    const loaded = await svc.loadWizard('wiz1');
    assert.deepStrictEqual(loaded, { docType: 'invoice', displayName: 'Test' });

    // Firestore repo should NOT have the data
    assert.strictEqual(repo.data['wizards/wiz1'], undefined);
  }

  // Test 4: Enable Firestore, writes go to repo
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    const repo = createMockRepo();
    // Use mock write queue that executes immediately
    const enqueuedOps = [];
    const mockQueue = {
      enqueue(op){ enqueuedOps.push(op); },
      flush: async () => {},
      destroy(){ },
      get pendingCount(){ return enqueuedOps.length; },
      get isFlushing(){ return false; }
    };
    const svc = new WizardDataService({ firestoreRepo: repo, localCache: cache, writeQueue: mockQueue });
    svc.init('uid123', 'testuser');
    svc.enableFirestore();

    assert.strictEqual(svc.isFirestoreEnabled, true);

    await svc.saveWizard('wiz1', { docType: 'invoice' });

    // Should have enqueued a write
    assert.strictEqual(enqueuedOps.length, 1);
    assert.ok(enqueuedOps[0].path.includes('wizards/wiz1'));
  }

  // Test 5: Load from Firestore first, then cache fallback
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    const repo = createMockRepo();
    const svc = new WizardDataService({ firestoreRepo: repo, localCache: cache });
    svc.init('uid123', 'testuser');
    svc.enableFirestore();

    // Put data in repo
    repo.data['wizards/wiz1'] = { docType: 'invoice', displayName: 'From Firestore' };

    const loaded = await svc.loadWizard('wiz1');
    assert.strictEqual(loaded.displayName, 'From Firestore');

    // Cache should now have it too
    const cached = cache.get('wizard:wiz1');
    assert.strictEqual(cached.displayName, 'From Firestore');
  }

  // Test 6: Firestore error falls back to cache
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    cache.set('wizard:wiz1', { docType: 'invoice', displayName: 'From Cache' });

    const failingRepo = {
      async getWizard(){ throw new Error('network error'); }
    };

    const errors = [];
    const svc = new WizardDataService({ firestoreRepo: failingRepo, localCache: cache });
    svc.init('uid123', 'testuser');
    svc.enableFirestore();
    svc.onError(e => errors.push(e));

    const loaded = await svc.loadWizard('wiz1');
    assert.strictEqual(loaded.displayName, 'From Cache', 'should fall back to cache');
    assert.strictEqual(errors.length, 1, 'should emit error');
    assert.ok(errors[0].message.includes('network error'));
  }

  // Test 7: Pattern bundle save (direct, not queued)
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    const repo = createMockRepo();
    const svc = new WizardDataService({ firestoreRepo: repo, localCache: cache });
    svc.init('uid123', 'testuser');
    svc.enableFirestore();

    const bundle = { patterns: [{ id: 'p1', data: 'x'.repeat(100) }] };
    await svc.savePatternBundle('wiz1', 'layout1', bundle);

    assert.ok(repo.data['wizards/wiz1/patterns/layout1']);
    assert.deepStrictEqual(repo.data['wizards/wiz1/patterns/layout1'].patternData, bundle);
  }

  // Test 8: hydrateWizard loads all related data
  {
    localStorage.clear();
    const cache = new LocalCacheAdapter({ maxBytes: 100000, ttlMs: 60000 });
    const repo = createMockRepo();
    const svc = new WizardDataService({ firestoreRepo: repo, localCache: cache });
    svc.init('uid123', 'testuser');
    svc.enableFirestore();

    repo.data['wizards/wiz1'] = { wizardId: 'wiz1', docType: 'invoice' };
    repo.data['wizards/wiz1/layouts/layout1'] = { layoutId: 'layout1' };
    repo.data['wizards/wiz1/masterDb/current'] = { entries: [{ id: 1 }] };

    const result = await svc.hydrateWizard('wiz1', 'layout1');
    assert.ok(result.wizard);
    assert.strictEqual(result.wizard.wizardId, 'wiz1');
    assert.ok(result.layout);
    assert.strictEqual(result.layout.layoutId, 'layout1');
    assert.strictEqual(result.masterDb.length, 1);
  }

  // Test 9: error listener registration and removal
  {
    const svc = new WizardDataService({});
    const errors = [];
    const unsub = svc.onError(e => errors.push(e));
    svc._emitError(new Error('test'), { action: 'test' });
    assert.strictEqual(errors.length, 1);
    unsub();
    svc._emitError(new Error('test2'), { action: 'test2' });
    assert.strictEqual(errors.length, 1, 'should not receive after unsubscribe');
  }

  console.log('WizardDataService tests passed.');
}

main();
