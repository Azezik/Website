(function(root){
  'use strict';

  /**
   * Data layer bootstrap: creates and wires together all data modules.
   *
   * Usage:
   *   const dataLayer = WrokitDataLayer.create();
   *   await dataLayer.init(uid, username);
   *
   * This is the single entry point for the wizard data system.
   * All other modules (FirestoreRepo, LocalCacheAdapter, WriteQueue, etc.)
   * are composed here.
   */

  function create(opts = {}){
    const telemetry = root.DataTelemetry || opts.telemetry || null;

    const firestoreRepo = new (root.FirestoreRepo || opts.FirestoreRepo || class{})(
      { telemetry }
    );

    const localCache = new (root.LocalCacheAdapter || opts.LocalCacheAdapter || class{})(
      { telemetry, maxBytes: opts.cacheMaxBytes || 2 * 1024 * 1024, ttlMs: opts.cacheTtlMs || 24 * 60 * 60 * 1000 }
    );

    const writeQueue = new (root.WriteQueue || opts.WriteQueue || class{})(
      {
        telemetry,
        debounceMs: opts.debounceMs || 2000,
        maxBatchSize: opts.maxBatchSize || 10,
        maxRetries: opts.maxRetries || 3,
        flushFn: async (ops) => {
          // Execute batched writes via FirestoreRepo
          const uid = service._uid;
          if(!uid){
            console.warn('[data-layer] flush called without uid');
            return;
          }
          // Group by collection for potential batch optimization
          for(const op of ops){
            const pathParts = op.path.split('/');
            // path format: users/{uid}/...subcollection.../docId
            // Remove the users/{uid} prefix to get subcollection path
            const subPath = pathParts.slice(2);
            try {
              const api = root.firebaseApi;
              if(!api?.db || !api?.doc || !api?.setDoc) throw new Error('Firebase unavailable');
              const ref = api.doc(api.db, 'users', uid, ...subPath);
              if(op.type === 'delete'){
                await api.setDoc(ref, { _deleted: true, updatedAt: api.serverTimestamp() }, { merge: true });
              } else {
                await api.setDoc(ref, { ...op.data, updatedAt: api.serverTimestamp() }, { merge: true });
              }
              if(telemetry) telemetry.increment('firestoreWrites');
            } catch(err){
              if(telemetry) telemetry.increment('firestoreWriteFailures');
              throw err;
            }
          }
        },
        onError: (err, op) => {
          console.error('[data-layer] write failed permanently', err, op?.path);
          if(telemetry) telemetry.recordError('write-permanent-failure', err, { path: op?.path });
        }
      }
    );

    const service = new (root.WizardDataService || opts.WizardDataService || class{})(
      {
        firestoreRepo,
        localCache,
        writeQueue,
        telemetry
      }
    );

    const migration = new (root.MigrationUtility || opts.MigrationUtility || class{})(
      {
        firestoreRepo,
        telemetry
      }
    );

    return {
      service,
      migration,
      firestoreRepo,
      localCache,
      writeQueue,
      telemetry,

      /**
       * Initialize the data layer with authenticated user.
       * Checks for and runs migration if needed.
       */
      async init(uid, username){
        service.init(uid, username);

        // Check if Firestore is enabled and migration is needed
        if(service.isFirestoreEnabled){
          const needed = await migration.isMigrationNeeded(uid);
          if(needed){
            console.info('[data-layer] migration needed, starting...');
            const result = await migration.migrate(uid, username);
            console.info('[data-layer] migration result:', result);
          }
        }

        return { ready: true, firestoreEnabled: service.isFirestoreEnabled };
      },

      /**
       * Enable Firestore persistence and trigger migration.
       */
      async enableFirestoreAndMigrate(uid, username){
        service.enableFirestore();
        const result = await migration.migrate(uid, username);
        return result;
      },

      /**
       * Get diagnostic info for debugging.
       */
      getDiagnostics(){
        return {
          firestoreEnabled: service.isFirestoreEnabled,
          pendingWrites: writeQueue.pendingCount || 0,
          isFlushing: writeQueue.isFlushing || false,
          cacheStats: localCache.getCacheStats ? localCache.getCacheStats() : null,
          telemetry: telemetry ? telemetry.getSnapshot() : null,
          migrationStatus: migration.getMigrationStatus ? migration.getMigrationStatus() : null
        };
      },

      destroy(){
        service.destroy();
      }
    };
  }

  const WrokitDataLayer = { create };

  if(typeof module === 'object' && module.exports){
    module.exports = WrokitDataLayer;
  } else {
    root.WrokitDataLayer = WrokitDataLayer;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
