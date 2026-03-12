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

const MigrationUtility = require('../js/data/migration.js');

// Mock FirestoreRepo that records all writes
function createMockRepo(){
  const writes = {};
  return {
    writes,
    async getProfile(uid){
      return writes[`profile:${uid}`] || null;
    },
    async setProfile(uid, data){
      writes[`profile:${uid}`] = { ...(writes[`profile:${uid}`] || {}), ...data };
    },
    async setWizard(uid, wizardId, data){
      writes[`wizard:${uid}:${wizardId}`] = data;
    },
    async setLayout(uid, wizardId, layoutId, data){
      writes[`layout:${uid}:${wizardId}:${layoutId}`] = data;
    },
    async setField(uid, wizardId, layoutId, fieldKey, data){
      writes[`field:${uid}:${wizardId}:${layoutId}:${fieldKey}`] = data;
    },
    async setPatternBundle(uid, wizardId, layoutId, data){
      writes[`pattern:${uid}:${wizardId}:${layoutId}`] = data;
    },
    async setMasterDb(uid, wizardId, entries){
      writes[`masterDb:${uid}:${wizardId}`] = entries;
    },
    async setMasterDbRows(uid, wizardId, rows){
      writes[`masterDbRows:${uid}:${wizardId}`] = rows;
    },
    async setChartReady(uid, wizardId, data){
      writes[`chartReady:${uid}:${wizardId}`] = data;
    },
    async setTemplates(uid, templates){
      writes[`templates:${uid}`] = templates;
    },
    async setModels(uid, models){
      writes[`models:${uid}`] = models;
    },
    async setOcrSegments(uid, seg, chunks){
      writes[`ocr:${uid}`] = { seg, chunks };
    }
  };
}

async function main(){
  // Test 1: migration needed when no marker exists
  {
    localStorage.clear();
    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    const needed = await migration.isMigrationNeeded('uid1');
    assert.strictEqual(needed, true);
  }

  // Test 2: migration not needed when marker is complete
  {
    localStorage.clear();
    localStorage.setItem('wrokit.migration.status', JSON.stringify({
      uid: 'uid1', status: 'complete', version: 1
    }));
    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    const needed = await migration.isMigrationNeeded('uid1');
    assert.strictEqual(needed, false);
  }

  // Test 3: migration needed for different uid
  {
    localStorage.clear();
    localStorage.setItem('wrokit.migration.status', JSON.stringify({
      uid: 'uid1', status: 'complete', version: 1
    }));
    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    const needed = await migration.isMigrationNeeded('uid2');
    assert.strictEqual(needed, true);
  }

  // Test 4: collect localStorage data — profiles
  {
    localStorage.clear();
    localStorage.setItem('wiz.profile.testuser.invoice', JSON.stringify({
      fields: [
        { fieldKey: 'vendor', label: 'Vendor', bbox: [10, 20, 100, 40] },
        { fieldKey: 'total', label: 'Total', bbox: [10, 50, 100, 70] }
      ],
      engine: 'wrokit_vision'
    }));
    localStorage.setItem('wiz.session', JSON.stringify({ username: 'testuser', docType: 'invoice' }));
    localStorage.setItem('wiz.customTemplates', JSON.stringify([
      { id: 'tpl1', username: 'testuser', documentTypeId: 'invoice' },
      { id: 'tpl2', username: 'otheruser', documentTypeId: 'receipt' }
    ]));

    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    const data = migration._collectLocalStorageData('testuser');

    assert.ok(data.session);
    assert.strictEqual(data.session.username, 'testuser');
    assert.strictEqual(data.customTemplates.length, 1, 'should filter to user');
    assert.strictEqual(data.customTemplates[0].id, 'tpl1');
    assert.ok(data.wizards.invoice);
    assert.ok(data.wizards.invoice.default);
    assert.strictEqual(data.wizards.invoice.default.profile.fields.length, 2);
  }

  // Test 5: full migration writes normalized docs
  {
    localStorage.clear();
    localStorage.setItem('wiz.profile.testuser.invoice', JSON.stringify({
      fields: [
        { fieldKey: 'vendor', label: 'Vendor', bbox: [10, 20, 100, 40] },
        { fieldKey: 'total', label: 'Total', bbox: [10, 50, 100, 70] }
      ],
      engine: 'wrokit_vision'
    }));
    localStorage.setItem('accounts.testuser.wizards.invoice.masterdb', JSON.stringify([
      { vendor: 'Acme', total: 100 }
    ]));

    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    const result = await migration.migrate('uid1', 'testuser');

    assert.strictEqual(result.status, 'complete');

    // Check wizard was written
    assert.ok(repo.writes['wizard:uid1:default'], 'wizard metadata should be written');
    assert.strictEqual(repo.writes['wizard:uid1:default'].docType, 'invoice');

    // Check layout was written
    assert.ok(repo.writes['layout:uid1:default:default_geometry'], 'layout should be written');

    // Check fields were written
    assert.ok(repo.writes['field:uid1:default:default_geometry:vendor']);
    assert.ok(repo.writes['field:uid1:default:default_geometry:total']);
    assert.strictEqual(repo.writes['field:uid1:default:default_geometry:vendor'].label, 'Vendor');

    // Check master DB was written
    assert.ok(repo.writes['masterDb:uid1:default']);
    assert.strictEqual(repo.writes['masterDb:uid1:default'].length, 1);

    // Check migration marker
    assert.strictEqual(repo.writes['profile:uid1'].migrationStatus, 'complete');
  }

  // Test 6: idempotent — second migration returns already-complete
  {
    // Marker was set by test 5
    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    const result = await migration.migrate('uid1', 'testuser');
    assert.strictEqual(result.status, 'already-complete');
  }

  // Test 7: merge payloads — local wins, cloud fills gaps
  {
    const migration = new MigrationUtility({});
    const local = {
      wizards: {
        invoice: {
          default: { profile: { fields: [{ fieldKey: 'vendor' }] } }
        }
      },
      customTemplates: [{ id: 'a' }],
      models: []
    };
    const cloud = {
      wizards: {
        invoice: {
          default: { profile: { fields: [{ fieldKey: 'old_vendor' }] } },
          custom1: { profile: { fields: [{ fieldKey: 'amount' }] } }
        },
        receipt: {
          default: { profile: { fields: [{ fieldKey: 'store' }] } }
        }
      },
      customTemplates: [{ id: 'a' }, { id: 'b' }],
      models: [{ id: 'm1' }]
    };

    const merged = migration._mergePayloads(local, cloud);

    // Local wizard should win
    assert.strictEqual(merged.wizards.invoice.default.profile.fields[0].fieldKey, 'vendor');
    // Cloud-only wizard should be added
    assert.ok(merged.wizards.invoice.custom1);
    assert.ok(merged.wizards.receipt);
    // Templates: deduplicate by id
    assert.strictEqual(merged.customTemplates.length, 2); // 'a' from local + 'b' from cloud
    // Models from cloud
    assert.strictEqual(merged.models.length, 1);
  }

  // Test 8: telemetry integration
  {
    localStorage.clear();
    const counters = { migrationAttempts: 0, migrationSuccesses: 0 };
    const telemetry = {
      increment(name){ counters[name] = (counters[name] || 0) + 1; },
      recordError(){},
      recordPayloadSize(){}
    };

    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo, telemetry });
    await migration.migrate('uid1', 'testuser');
    assert.strictEqual(counters.migrationAttempts, 1);
    assert.strictEqual(counters.migrationSuccesses, 1);
  }

  // Test 9: getMigrationStatus returns marker
  {
    localStorage.clear();
    const repo = createMockRepo();
    const migration = new MigrationUtility({ firestoreRepo: repo });
    assert.strictEqual(migration.getMigrationStatus(), null);

    localStorage.setItem('wrokit.migration.status', JSON.stringify({ uid: 'uid1', status: 'complete', version: 1 }));
    const status = migration.getMigrationStatus();
    assert.strictEqual(status.status, 'complete');
  }

  console.log('MigrationUtility tests passed.');
}

main();
