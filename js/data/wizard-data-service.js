(function(root){
  'use strict';

  const FEATURE_FLAG_KEY = 'wrokit.firestorePrimary';
  const MIGRATION_STATUS_KEY = 'wrokit.migrationStatus';

  /**
   * WizardDataService: orchestrates all wizard data reads/writes.
   *
   * - Reads: Firestore first, localStorage cache fallback
   * - Writes: Firestore primary via WriteQueue, localStorage cache write-through
   * - Manages conflict detection via version fields
   * - Provides user-visible error states
   */
  class WizardDataService {
    constructor(opts = {}){
      this._repo = opts.firestoreRepo || null;
      this._cache = opts.localCache || null;
      this._writeQueue = opts.writeQueue || null;
      this._telemetry = opts.telemetry || null;
      this._uid = null;
      this._username = null;
      this._errorListeners = [];
      this._initialized = false;
    }

    /**
     * Initialize with authenticated user context.
     * Must be called after auth resolves.
     */
    init(uid, username){
      this._uid = uid;
      this._username = username;
      this._initialized = true;
    }

    get isReady(){
      return this._initialized && !!this._uid;
    }

    get isFirestoreEnabled(){
      try {
        return localStorage.getItem(FEATURE_FLAG_KEY) === '1';
      } catch{ return false; }
    }

    enableFirestore(){
      try { localStorage.setItem(FEATURE_FLAG_KEY, '1'); } catch{}
    }

    disableFirestore(){
      try { localStorage.setItem(FEATURE_FLAG_KEY, '0'); } catch{}
    }

    onError(fn){
      this._errorListeners.push(fn);
      return () => {
        this._errorListeners = this._errorListeners.filter(f => f !== fn);
      };
    }

    _emitError(error, context){
      const entry = {
        message: error?.message || String(error),
        code: error?.code || null,
        context,
        timestamp: Date.now()
      };
      this._errorListeners.forEach(fn => { try { fn(entry); } catch{} });
      if(this._telemetry) this._telemetry.recordError('wizard-data-service', error, context);
    }

    // ---- Profile ----

    async loadProfile(uid){
      const resolvedUid = uid || this._uid;
      if(!resolvedUid) return null;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getProfile(resolvedUid);
          if(data){
            this._cacheWrite('profile', data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadProfile', source: 'firestore' });
        }
      }
      // Fallback to cache
      return this._cacheRead('profile');
    }

    async saveProfile(uid, data){
      const resolvedUid = uid || this._uid;
      if(!resolvedUid) return;

      // Optimistic local cache write
      this._cacheWrite('profile', data);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${resolvedUid}/meta/profile`,
          collection: 'meta',
          docId: 'profile',
          data,
          type: 'set'
        });
      }
    }

    // ---- Wizard Metadata ----

    async loadWizard(wizardId){
      if(!this._uid) return null;
      const cachePath = `wizard:${wizardId}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getWizard(this._uid, wizardId);
          if(data && data.status !== 'deleted'){
            this._cacheWrite(cachePath, data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadWizard', wizardId });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveWizard(wizardId, data){
      if(!this._uid) return;
      const cachePath = `wizard:${wizardId}`;
      this._cacheWrite(cachePath, data);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/wizards/${wizardId}`,
          collection: 'wizards',
          docId: wizardId,
          data,
          type: 'set'
        });
      }
    }

    // ---- Layout ----

    async loadLayout(wizardId, layoutId){
      if(!this._uid) return null;
      const cachePath = `layout:${wizardId}:${layoutId}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getLayout(this._uid, wizardId, layoutId);
          if(data){
            this._cacheWrite(cachePath, data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadLayout', wizardId, layoutId });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveLayout(wizardId, layoutId, data){
      if(!this._uid) return;
      const cachePath = `layout:${wizardId}:${layoutId}`;
      this._cacheWrite(cachePath, data);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/wizards/${wizardId}/layouts/${layoutId}`,
          collection: 'layouts',
          docId: layoutId,
          data,
          type: 'set'
        });
      }
    }

    // ---- Field ----

    async loadField(wizardId, layoutId, fieldKey){
      if(!this._uid) return null;
      const cachePath = `field:${wizardId}:${layoutId}:${fieldKey}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getField(this._uid, wizardId, layoutId, fieldKey);
          if(data){
            this._cacheWrite(cachePath, data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadField', wizardId, layoutId, fieldKey });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveField(wizardId, layoutId, fieldKey, data){
      if(!this._uid) return;
      const cachePath = `field:${wizardId}:${layoutId}:${fieldKey}`;
      this._cacheWrite(cachePath, data);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/wizards/${wizardId}/layouts/${layoutId}/fields/${fieldKey}`,
          collection: 'fields',
          docId: fieldKey,
          data,
          type: 'set'
        });
      }
    }

    // ---- Pattern Bundle ----

    async loadPatternBundle(wizardId, layoutId){
      if(!this._uid) return null;
      const cachePath = `pattern:${wizardId}:${layoutId}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getPatternBundle(this._uid, wizardId, layoutId);
          if(data){
            this._cacheWrite(cachePath, data.patternData || data);
            return data.patternData || data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadPatternBundle', wizardId, layoutId });
        }
      }
      return this._cacheRead(cachePath);
    }

    async savePatternBundle(wizardId, layoutId, patternData){
      if(!this._uid) return;
      const cachePath = `pattern:${wizardId}:${layoutId}`;
      this._cacheWrite(cachePath, patternData);

      if(this.isFirestoreEnabled && this._repo){
        // Pattern bundles can be large — write directly (not via queue)
        try {
          await this._repo.setPatternBundle(this._uid, wizardId, layoutId, patternData);
        } catch(err){
          this._emitError(err, { action: 'savePatternBundle', wizardId, layoutId });
        }
      }
    }

    // ---- Master DB ----

    async loadMasterDb(wizardId){
      if(!this._uid) return [];
      const cachePath = `masterDb:${wizardId}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getMasterDb(this._uid, wizardId);
          if(data){
            this._cacheWrite(cachePath, data.entries || []);
            return data.entries || [];
          }
        } catch(err){
          this._emitError(err, { action: 'loadMasterDb', wizardId });
        }
      }
      return this._cacheRead(cachePath) || [];
    }

    async saveMasterDb(wizardId, entries){
      if(!this._uid) return;
      const cachePath = `masterDb:${wizardId}`;
      this._cacheWrite(cachePath, entries);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/wizards/${wizardId}/masterDb/current`,
          collection: 'masterDb',
          docId: 'current',
          data: { entries, entryCount: Array.isArray(entries) ? entries.length : 0 },
          type: 'set'
        });
      }
    }

    // ---- Master DB Rows ----

    async loadMasterDbRows(wizardId){
      if(!this._uid) return null;
      const cachePath = `masterDbRows:${wizardId}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getMasterDbRows(this._uid, wizardId);
          if(data){
            this._cacheWrite(cachePath, data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadMasterDbRows', wizardId });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveMasterDbRows(wizardId, rowsPayload){
      if(!this._uid) return;
      const cachePath = `masterDbRows:${wizardId}`;
      this._cacheWrite(cachePath, rowsPayload);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/wizards/${wizardId}/masterDbRows/current`,
          collection: 'masterDbRows',
          docId: 'current',
          data: rowsPayload,
          type: 'set'
        });
      }
    }

    // ---- Chart Ready ----

    async loadChartReady(wizardId){
      if(!this._uid) return null;
      const cachePath = `chartReady:${wizardId}`;

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getChartReady(this._uid, wizardId);
          if(data){
            this._cacheWrite(cachePath, data.data || data);
            return data.data || data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadChartReady', wizardId });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveChartReady(wizardId, data){
      if(!this._uid) return;
      const cachePath = `chartReady:${wizardId}`;
      this._cacheWrite(cachePath, data);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/wizards/${wizardId}/chartReady/current`,
          collection: 'chartReady',
          docId: 'current',
          data: { data },
          type: 'set'
        });
      }
    }

    // ---- Templates ----

    async loadTemplates(){
      if(!this._uid) return [];
      const cachePath = 'templates';

      if(this.isFirestoreEnabled && this._repo){
        try {
          const items = await this._repo.getTemplates(this._uid);
          if(items){
            this._cacheWrite(cachePath, items);
            return items;
          }
        } catch(err){
          this._emitError(err, { action: 'loadTemplates' });
        }
      }
      return this._cacheRead(cachePath) || [];
    }

    async saveTemplates(templates){
      if(!this._uid) return;
      const cachePath = 'templates';
      this._cacheWrite(cachePath, templates);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/templates/_all`,
          collection: 'templates',
          docId: '_all',
          data: { items: templates },
          type: 'set'
        });
      }
    }

    // ---- Models ----

    async loadModels(){
      if(!this._uid) return [];
      const cachePath = 'models';

      if(this.isFirestoreEnabled && this._repo){
        try {
          const items = await this._repo.getModels(this._uid);
          if(items){
            this._cacheWrite(cachePath, items);
            return items;
          }
        } catch(err){
          this._emitError(err, { action: 'loadModels' });
        }
      }
      return this._cacheRead(cachePath) || [];
    }

    async saveModels(models){
      if(!this._uid) return;
      const cachePath = 'models';
      this._cacheWrite(cachePath, models);

      if(this.isFirestoreEnabled && this._repo){
        this._enqueueWrite({
          path: `users/${this._uid}/models/_all`,
          collection: 'models',
          docId: '_all',
          data: { items: models },
          type: 'set'
        });
      }
    }

    // ---- OCR Segments ----

    async loadOcrSegments(){
      if(!this._uid) return null;
      const cachePath = 'ocrSegments';

      if(this.isFirestoreEnabled && this._repo){
        try {
          const data = await this._repo.getOcrSegments(this._uid);
          if(data){
            this._cacheWrite(cachePath, data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadOcrSegments' });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveOcrSegments(segmentStore, segmentStoreChunks){
      if(!this._uid) return;
      const cachePath = 'ocrSegments';
      const payload = { segmentStore, segmentStoreChunks };
      this._cacheWrite(cachePath, payload);

      if(this.isFirestoreEnabled && this._repo){
        // OCR data can be large — write directly
        try {
          await this._repo.setOcrSegments(this._uid, segmentStore, segmentStoreChunks);
        } catch(err){
          this._emitError(err, { action: 'saveOcrSegments' });
        }
      }
    }

    // ---- Learning Data ----

    async loadLearningData(){
      if(!this._uid) return null;
      const cachePath = 'learning';

      if(this.isFirestoreEnabled && this._repo?.getLearningData){
        try {
          const data = await this._repo.getLearningData(this._uid);
          if(data){
            this._cacheWrite(cachePath, data);
            return data;
          }
        } catch(err){
          this._emitError(err, { action: 'loadLearningData' });
        }
      }
      return this._cacheRead(cachePath);
    }

    async saveLearningData(learningData){
      if(!this._uid) return;
      const cachePath = 'learning';
      this._cacheWrite(cachePath, learningData);

      if(this.isFirestoreEnabled && this._repo?.setLearningData){
        // Learning data can be large — write directly
        try {
          await this._repo.setLearningData(this._uid, learningData);
        } catch(err){
          this._emitError(err, { action: 'saveLearningData' });
        }
      }
    }

    // ---- Hydrate full wizard (load all related data) ----

    async hydrateWizard(wizardId, layoutId){
      if(!this._uid) return null;

      const result = {
        wizard: null,
        layout: null,
        fields: [],
        patternBundle: null,
        masterDb: [],
        masterDbRows: null,
        chartReady: null
      };

      try {
        const [wizard, layout, masterDb, masterDbRows, chartReady, patternBundle] = await Promise.all([
          this.loadWizard(wizardId),
          layoutId ? this.loadLayout(wizardId, layoutId) : Promise.resolve(null),
          this.loadMasterDb(wizardId),
          this.loadMasterDbRows(wizardId),
          this.loadChartReady(wizardId),
          layoutId ? this.loadPatternBundle(wizardId, layoutId) : Promise.resolve(null)
        ]);

        result.wizard = wizard;
        result.layout = layout;
        result.masterDb = masterDb;
        result.masterDbRows = masterDbRows;
        result.chartReady = chartReady;
        result.patternBundle = patternBundle;
      } catch(err){
        this._emitError(err, { action: 'hydrateWizard', wizardId, layoutId });
      }

      return result;
    }

    // ---- Flush pending writes ----

    async flush(){
      if(this._writeQueue) return this._writeQueue.flush();
    }

    get pendingWriteCount(){
      return this._writeQueue ? this._writeQueue.pendingCount : 0;
    }

    // ---- Internal helpers ----

    _cacheRead(path){
      if(!this._cache) return null;
      return this._cache.get(path);
    }

    _cacheWrite(path, data){
      if(!this._cache) return;
      this._cache.set(path, data);
    }

    _enqueueWrite(op){
      if(this._writeQueue){
        this._writeQueue.enqueue(op);
      }
    }

    destroy(){
      if(this._writeQueue) this._writeQueue.destroy();
    }
  }

  if(typeof module === 'object' && module.exports){
    module.exports = WizardDataService;
  } else {
    root.WizardDataService = WizardDataService;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
