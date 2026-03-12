(function(root){
  'use strict';

  const MIGRATION_MARKER_KEY = 'wrokit.migration.status';
  const MIGRATION_VERSION = 1;
  const DEFAULT_WIZARD_ID = 'default';
  const DEFAULT_GEOMETRY_ID = 'default_geometry';

  /**
   * MigrationUtility: one-time migration from legacy localStorage + Backups/manual
   * to the normalized Firestore schema.
   *
   * Idempotent: checks migration marker before running.
   * Supports dual-read during rollout period.
   */
  class MigrationUtility {
    constructor(opts = {}){
      this._repo = opts.firestoreRepo || null;
      this._telemetry = opts.telemetry || null;
      this._jsonReviver = opts.jsonReviver || null;
      this._jsonReplacer = opts.jsonReplacer || null;
    }

    /**
     * Check if migration is needed for this user.
     */
    async isMigrationNeeded(uid){
      // Check local marker first (fast path)
      try {
        const local = localStorage.getItem(MIGRATION_MARKER_KEY);
        if(local){
          const parsed = JSON.parse(local);
          if(parsed.status === 'complete' && parsed.uid === uid && parsed.version >= MIGRATION_VERSION){
            return false;
          }
        }
      } catch{}

      // Check Firestore marker
      if(this._repo){
        try {
          const profile = await this._repo.getProfile(uid);
          if(profile?.migrationStatus === 'complete' && profile?.migrationVersion >= MIGRATION_VERSION){
            // Sync local marker
            this._setLocalMarker(uid, 'complete');
            return false;
          }
        } catch(err){
          console.warn('[migration] failed to check Firestore marker', err);
        }
      }

      return true;
    }

    /**
     * Run the full migration: localStorage + Backups/manual → normalized Firestore.
     */
    async migrate(uid, username){
      if(this._telemetry) this._telemetry.increment('migrationAttempts');

      const needed = await this.isMigrationNeeded(uid);
      if(!needed){
        console.info('[migration] already complete for', uid);
        return { status: 'already-complete' };
      }

      this._setLocalMarker(uid, 'in-progress');

      try {
        // Step 1: Collect data from localStorage
        const localData = this._collectLocalStorageData(username);

        // Step 2: Collect data from Backups/manual (if exists)
        const cloudData = await this._collectCloudBackup(uid, username);

        // Step 3: Merge (localStorage wins for newer data)
        const merged = this._mergePayloads(localData, cloudData);

        // Step 4: Write normalized documents to Firestore
        await this._writeNormalizedData(uid, username, merged);

        // Step 5: Write migration marker
        await this._completeMigration(uid, username);

        if(this._telemetry) this._telemetry.increment('migrationSuccesses');
        return { status: 'complete', wizardCount: Object.keys(merged.wizards || {}).length };

      } catch(err){
        this._setLocalMarker(uid, 'failed');
        if(this._telemetry){
          this._telemetry.increment('migrationFailures');
          this._telemetry.recordError('migration', err, { uid });
        }
        console.error('[migration] failed', err);
        return { status: 'failed', error: err.message };
      }
    }

    /**
     * Collect all wizard data from localStorage.
     */
    _collectLocalStorageData(username){
      const result = {
        source: 'localStorage',
        session: null,
        customTemplates: [],
        models: [],
        ocrmagic: {},
        wizards: {},
        settings: {}
      };

      // Session
      try {
        const raw = localStorage.getItem('wiz.session');
        result.session = raw ? JSON.parse(raw) : null;
      } catch{}

      // Settings
      try {
        result.settings.staticDebug = localStorage.getItem('wiz.staticDebug');
        result.settings.snapshotMode = localStorage.getItem('wiz.snapshotMode');
        result.settings.extractionEngine = localStorage.getItem('wiz.extractionEngine');
      } catch{}

      // Templates
      try {
        const raw = localStorage.getItem('wiz.customTemplates');
        const all = raw ? JSON.parse(raw) : [];
        result.customTemplates = Array.isArray(all) ? all.filter(t => t?.username === username) : [];
      } catch{}

      // Models
      try {
        const raw = localStorage.getItem('wiz.models');
        const all = raw ? JSON.parse(raw, this._jsonReviver) : [];
        result.models = Array.isArray(all) ? all.filter(m => m?.username === username) : [];
      } catch{}

      // OCR segments
      try {
        result.ocrmagic.segmentStore = localStorage.getItem('ocrmagic.segmentStore') || null;
        result.ocrmagic.segmentStoreChunks = localStorage.getItem('ocrmagic.segmentStore.chunks') || null;
      } catch{}

      // Scan for wizard profiles, masterDb, rows, patterns, geometries
      try {
        const profilePrefix = `wiz.profile.${username}.`;
        const dbPrefix = `accounts.${username}.wizards.`;
        const geometryPrefix = `wiz.geometries.${username}.`;
        const patternPrefix = 'wiz.patternBundle.';

        for(let i = 0; i < localStorage.length; i++){
          const key = localStorage.key(i);
          if(!key) continue;

          // Profiles: wiz.profile.{user}.{docType}[.{wizardId}][.{geometryId}]
          if(key.startsWith(profilePrefix)){
            const parts = key.slice(profilePrefix.length).split('.');
            const docType = parts[0] || 'invoice';
            const wizardId = parts[1] || DEFAULT_WIZARD_ID;
            const geometryId = parts[2] || null;

            if(!result.wizards[docType]) result.wizards[docType] = {};
            if(!result.wizards[docType][wizardId]) result.wizards[docType][wizardId] = { geometries: {} };

            try {
              const profile = JSON.parse(localStorage.getItem(key), this._jsonReviver);
              if(geometryId){
                result.wizards[docType][wizardId].geometries[geometryId] = { profile };
              } else {
                result.wizards[docType][wizardId].profile = profile;
              }
            } catch{}
          }

          // Master DB: accounts.{user}.wizards.{docType}[.{wizardId}].masterdb
          if(key.startsWith(dbPrefix) && key.endsWith('.masterdb')){
            const middle = key.slice(dbPrefix.length, key.length - '.masterdb'.length);
            const parts = middle.split('.');
            const docType = parts[0] || 'invoice';
            const wizardId = parts[1] || DEFAULT_WIZARD_ID;

            if(!result.wizards[docType]) result.wizards[docType] = {};
            if(!result.wizards[docType][wizardId]) result.wizards[docType][wizardId] = { geometries: {} };

            try {
              result.wizards[docType][wizardId].masterDb = JSON.parse(localStorage.getItem(key));
            } catch{}
          }

          // Master DB rows
          if(key.startsWith(dbPrefix) && key.endsWith('.masterdb_rows')){
            const middle = key.slice(dbPrefix.length, key.length - '.masterdb_rows'.length);
            const parts = middle.split('.');
            const docType = parts[0] || 'invoice';
            const wizardId = parts[1] || DEFAULT_WIZARD_ID;

            if(!result.wizards[docType]) result.wizards[docType] = {};
            if(!result.wizards[docType][wizardId]) result.wizards[docType][wizardId] = { geometries: {} };

            try {
              result.wizards[docType][wizardId].masterDbRows = JSON.parse(localStorage.getItem(key));
            } catch{}
          }

          // Chart ready
          if(key.startsWith(dbPrefix) && key.endsWith('.chartready')){
            const middle = key.slice(dbPrefix.length, key.length - '.chartready'.length);
            const parts = middle.split('.');
            const docType = parts[0] || 'invoice';
            const wizardId = parts[1] || DEFAULT_WIZARD_ID;

            if(!result.wizards[docType]) result.wizards[docType] = {};
            if(!result.wizards[docType][wizardId]) result.wizards[docType][wizardId] = { geometries: {} };

            try {
              result.wizards[docType][wizardId].chartReady = JSON.parse(localStorage.getItem(key));
            } catch{}
          }

          // Geometry metadata
          if(key.startsWith(geometryPrefix)){
            const parts = key.slice(geometryPrefix.length).split('.');
            const docType = parts[0] || 'invoice';
            const wizardId = parts[1] || DEFAULT_WIZARD_ID;

            if(!result.wizards[docType]) result.wizards[docType] = {};
            if(!result.wizards[docType][wizardId]) result.wizards[docType][wizardId] = { geometries: {} };

            try {
              const geoMeta = JSON.parse(localStorage.getItem(key), this._jsonReviver);
              result.wizards[docType][wizardId].geometryMeta = Array.isArray(geoMeta) ? geoMeta : [];
            } catch{}
          }

          // Pattern bundles
          if(key.startsWith(patternPrefix)){
            const rest = key.slice(patternPrefix.length);
            const parts = rest.split('.');
            const docType = parts[0] || 'invoice';
            const wizardId = parts[1] || DEFAULT_WIZARD_ID;
            const geometryId = parts[2] || null;

            if(!result.wizards[docType]) result.wizards[docType] = {};
            if(!result.wizards[docType][wizardId]) result.wizards[docType][wizardId] = { geometries: {} };

            try {
              const patternBundle = JSON.parse(localStorage.getItem(key), this._jsonReviver);
              if(geometryId){
                if(!result.wizards[docType][wizardId].geometries[geometryId]){
                  result.wizards[docType][wizardId].geometries[geometryId] = {};
                }
                result.wizards[docType][wizardId].geometries[geometryId].patternBundle = patternBundle;
              } else {
                result.wizards[docType][wizardId].patternBundle = patternBundle;
              }
            } catch{}
          }
        }
      } catch(err){
        console.warn('[migration] localStorage scan error', err);
      }

      return result;
    }

    /**
     * Fetch existing cloud backup data.
     */
    async _collectCloudBackup(uid, username){
      const api = root.firebaseApi;
      if(!api?.db || !api?.doc || !api?.getDoc) return null;

      try {
        const ref = api.doc(api.db, 'Users', uid, 'Accounts', username, 'Backups', 'manual');
        const snap = await api.getDoc(ref);
        if(!snap.exists()) return null;
        const data = snap.data();
        return data?.payload || null;
      } catch(err){
        console.warn('[migration] cloud backup read failed', err);
        return null;
      }
    }

    /**
     * Merge localStorage data with cloud backup data.
     * localStorage wins (it's more recent in most cases).
     */
    _mergePayloads(localData, cloudData){
      if(!cloudData) return localData;
      if(!localData) return { ...cloudData, source: 'cloud' };

      const merged = { ...localData };

      // Merge wizards: local wins, but fill in missing wizards from cloud
      const cloudWizards = cloudData.wizards || {};
      for(const [docType, wizardMap] of Object.entries(cloudWizards)){
        if(!merged.wizards[docType]) merged.wizards[docType] = {};
        for(const [wizardId, wizData] of Object.entries(wizardMap || {})){
          if(!merged.wizards[docType][wizardId]){
            merged.wizards[docType][wizardId] = wizData;
          }
          // If local has the wizard but is missing geometries from cloud, fill in
          if(wizData.geometries && merged.wizards[docType][wizardId]){
            const localGeom = merged.wizards[docType][wizardId].geometries || {};
            for(const [gid, geomData] of Object.entries(wizData.geometries)){
              if(!localGeom[gid]){
                localGeom[gid] = geomData;
              }
            }
            merged.wizards[docType][wizardId].geometries = localGeom;
          }
        }
      }

      // Merge templates: deduplicate by id
      if(cloudData.customTemplates?.length){
        const localIds = new Set((merged.customTemplates || []).map(t => t?.id));
        const missing = cloudData.customTemplates.filter(t => t?.id && !localIds.has(t.id));
        merged.customTemplates = [...(merged.customTemplates || []), ...missing];
      }

      // Merge models
      if(cloudData.models?.length){
        const localModelIds = new Set((merged.models || []).map(m => m?.id || m?.name));
        const missingModels = cloudData.models.filter(m => {
          const id = m?.id || m?.name;
          return id && !localModelIds.has(id);
        });
        merged.models = [...(merged.models || []), ...missingModels];
      }

      return merged;
    }

    /**
     * Write the merged data to Firestore in the normalized schema.
     */
    async _writeNormalizedData(uid, username, data){
      if(!this._repo) throw new Error('FirestoreRepo not available');

      // Write user profile/settings
      await this._repo.setProfile(uid, {
        username,
        settings: data.settings || {},
        migrationStatus: 'in-progress',
        migrationVersion: MIGRATION_VERSION
      });

      // Write templates
      if(data.customTemplates?.length){
        await this._repo.setTemplates(uid, data.customTemplates);
      }

      // Write models
      if(data.models?.length){
        await this._repo.setModels(uid, data.models);
      }

      // Write OCR segments
      if(data.ocrmagic?.segmentStore){
        await this._repo.setOcrSegments(uid, data.ocrmagic.segmentStore, data.ocrmagic.segmentStoreChunks);
      }

      // Write wizards
      const wizards = data.wizards || {};
      for(const [docType, wizardMap] of Object.entries(wizards)){
        for(const [wizardId, wizData] of Object.entries(wizardMap || {})){
          // Write wizard metadata
          const geometries = wizData.geometries || {};
          const geometryMeta = wizData.geometryMeta || [];
          const layoutCount = Math.max(Object.keys(geometries).length, geometryMeta.length, 1);
          const fieldCount = wizData.profile?.fields?.length || 0;

          await this._repo.setWizard(uid, wizardId, {
            docType,
            displayName: wizardId === DEFAULT_WIZARD_ID ? `${docType} (default)` : wizardId,
            engine: wizData.profile?.engine || wizData.profile?.extractionEngine || 'default',
            status: 'configured',
            fieldCount,
            layoutCount,
            version: 0
          });

          // Write layouts and fields
          const layoutEntries = Object.keys(geometries).length > 0
            ? Object.entries(geometries)
            : [[DEFAULT_GEOMETRY_ID, { profile: wizData.profile }]];

          for(const [layoutId, geomData] of layoutEntries){
            const profile = geomData.profile || wizData.profile;
            const meta = geometryMeta.find(m => m?.geometryId === layoutId);

            await this._repo.setLayout(uid, wizardId, layoutId, {
              displayName: meta?.displayName || geomData?.displayName || `Layout ${layoutId}`,
              createdAt: meta?.createdAt || new Date().toISOString(),
              pageSize: meta?.pageSize || profile?.geometry?.pageSize || null,
              fieldKeys: (profile?.fields || []).map(f => f?.fieldKey || f?.fieldId).filter(Boolean),
              version: 0
            });

            // Write individual fields
            if(profile?.fields?.length){
              for(const field of profile.fields){
                const fieldKey = field.fieldKey || field.fieldId;
                if(!fieldKey) continue;
                await this._repo.setField(uid, wizardId, layoutId, fieldKey, {
                  label: field.label || field.fieldKey,
                  fieldType: field.fieldType || 'static',
                  bbox: field.bbox || null,
                  bboxPct: field.bboxPct || null,
                  normBox: field.normBox || null,
                  page: field.page || 0,
                  anchor: field.anchor || null,
                  landmark: field.landmark || null,
                  extractionSettings: field.extractionSettings || null,
                  version: 0
                });
              }
            }

            // Write pattern bundle for this layout
            const patternBundle = geomData.patternBundle || (layoutId === DEFAULT_GEOMETRY_ID ? wizData.patternBundle : null);
            if(patternBundle){
              await this._repo.setPatternBundle(uid, wizardId, layoutId, patternBundle);
            }
          }

          // Write master DB
          if(wizData.masterDb?.length){
            await this._repo.setMasterDb(uid, wizardId, wizData.masterDb);
          }

          // Write master DB rows
          if(wizData.masterDbRows){
            await this._repo.setMasterDbRows(uid, wizardId, wizData.masterDbRows);
          }

          // Write chart ready
          if(wizData.chartReady){
            await this._repo.setChartReady(uid, wizardId, wizData.chartReady);
          }
        }
      }
    }

    async _completeMigration(uid, username){
      // Write Firestore marker
      if(this._repo){
        await this._repo.setProfile(uid, {
          username,
          migrationStatus: 'complete',
          migrationVersion: MIGRATION_VERSION,
          migratedAt: new Date().toISOString()
        });
      }

      // Write local marker
      this._setLocalMarker(uid, 'complete');
    }

    _setLocalMarker(uid, status){
      try {
        localStorage.setItem(MIGRATION_MARKER_KEY, JSON.stringify({
          uid,
          status,
          version: MIGRATION_VERSION,
          timestamp: Date.now()
        }));
      } catch{}
    }

    /**
     * Get migration status for display.
     */
    getMigrationStatus(){
      try {
        const raw = localStorage.getItem(MIGRATION_MARKER_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch{ return null; }
    }
  }

  if(typeof module === 'object' && module.exports){
    module.exports = MigrationUtility;
  } else {
    root.MigrationUtility = MigrationUtility;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
