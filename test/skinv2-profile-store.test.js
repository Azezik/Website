const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'skinv2', 'profile-store.js'), 'utf8');

function createStoreRoot({ service, firebaseUid, legacySaveSpy, wrokitFactory }){
  const localStorageMap = new Map([['wrokit.firestorePrimary', '1']]);
  const root = {
    localStorage: {
      getItem(key){ return localStorageMap.has(key) ? localStorageMap.get(key) : null; }
    },
    _wrokitDataLayer: service ? { service, init: async ()=>{} } : null,
    WrokitDataLayer: wrokitFactory ? { create: wrokitFactory } : null,
    firebaseApi: firebaseUid ? { auth: { currentUser: { uid: firebaseUid } } } : null,
    console,
    globalThis: null
  };
  root.globalThis = root;
  vm.runInNewContext(source, root, { filename: 'profile-store.js' });
  const adapter = root.SkinV2ProfileStoreAdapter;
  return {
    store: adapter.createSkinV2ProfileStore({
      saveProfile: legacySaveSpy,
      loadProfile: () => null,
      migrateProfile: (p) => p
    }),
    root
  };
}

(async function testDefersWhenCloudEnabledButServiceMissing(){
  let legacySaveCalls = 0;
  const cloudCalls = [];
  const createdService = {
    isFirestoreEnabled: true,
    isReady: true,
    _uid: 'uid-from-service',
    saveProfile(uid, payload){ cloudCalls.push({ uid, payload }); }
  };
  const { store } = createStoreRoot({
    service: null,
    legacySaveSpy: () => { legacySaveCalls += 1; },
    wrokitFactory: () => ({ service: createdService, init: async ()=>{} })
  });

  store.saveProfile('u', 'invoice', { fields: [{ bbox: [0, 0, 1, 1] }] }, 'wizard-1', 'default');
  await Promise.resolve();
  await Promise.resolve();

  assert.strictEqual(legacySaveCalls, 1, 'deferred save should persist locally after bootstrap flush');
  assert.strictEqual(cloudCalls.length, 1, 'deferred save should flush to cloud once service is created');
  assert.strictEqual(cloudCalls[0].uid, 'uid-from-service');
})();

(async function testCloudSaveShortCircuitsAndAlsoPersistsLocalWhenUidAvailable(){
  let legacySaveCalls = 0;
  const cloudCalls = [];
  const service = {
    isFirestoreEnabled: true,
    isReady: true,
    _uid: 'uid-from-service',
    saveProfile(uid, payload){ cloudCalls.push({ uid, payload }); }
  };
  const { store } = createStoreRoot({ service, firebaseUid: 'uid-from-auth', legacySaveSpy: () => { legacySaveCalls += 1; } });
  store.saveProfile('u', 'invoice', { fields: [{ bbox: [0, 0, 1, 1] }] }, 'wizard-1', 'default');
  await Promise.resolve();
  assert.strictEqual(legacySaveCalls, 1, 'local persistence should remain in sync for manager/run readers');
  assert.strictEqual(cloudCalls.length, 1, 'cloud save should be called once');
  assert.strictEqual(cloudCalls[0].uid, 'uid-from-auth');
})();

console.log('SkinV2 profile store adapter tests passed.');
