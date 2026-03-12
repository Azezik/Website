const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'skinv2', 'profile-store.js'), 'utf8');

function createStoreRoot({ service, firebaseUid, legacySaveSpy }){
  const localStorageMap = new Map();
  if(service?.isFirestoreEnabled){
    localStorageMap.set('wrokit.firestorePrimary', '1');
  }
  const root = {
    localStorage: {
      getItem(key){ return localStorageMap.has(key) ? localStorageMap.get(key) : null; }
    },
    _wrokitDataLayer: service ? { service } : null,
    firebaseApi: firebaseUid ? { auth: { currentUser: { uid: firebaseUid } } } : null,
    console,
    globalThis: null
  };
  root.globalThis = root;
  vm.runInNewContext(source, root, { filename: 'profile-store.js' });
  const adapter = root.SkinV2ProfileStoreAdapter;
  return adapter.createSkinV2ProfileStore({
    saveProfile: legacySaveSpy,
    loadProfile: () => null,
    migrateProfile: (p) => p
  });
}

(function testFallsBackToLegacyWhenCloudEnabledButNoService(){
  let legacySaveCalls = 0;
  const store = createStoreRoot({ service: null, legacySaveSpy: () => { legacySaveCalls += 1; } });
  store.saveProfile('u', 'invoice', { fields: [{ bbox: [0, 0, 1, 1] }] }, 'wizard-1', 'default');
  assert.strictEqual(legacySaveCalls, 1, 'legacy save should still run when cloud service is unavailable');
})();

(async function testCloudSaveShortCircuitsLegacyWhenUidAvailable(){
  let legacySaveCalls = 0;
  const cloudCalls = [];
  const service = {
    isFirestoreEnabled: true,
    _uid: 'uid-from-service',
    saveProfile(uid, payload){ cloudCalls.push({ uid, payload }); }
  };
  const store = createStoreRoot({ service, firebaseUid: 'uid-from-auth', legacySaveSpy: () => { legacySaveCalls += 1; } });
  store.saveProfile('u', 'invoice', { fields: [{ bbox: [0, 0, 1, 1] }] }, 'wizard-1', 'default');
  await Promise.resolve();
  assert.strictEqual(legacySaveCalls, 0, 'legacy save should not run once cloud save is enqueued');
  assert.strictEqual(cloudCalls.length, 1, 'cloud save should be called once');
  assert.strictEqual(cloudCalls[0].uid, 'uid-from-auth');
})();

console.log('SkinV2 profile store adapter tests passed.');
