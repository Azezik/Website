(function(root){
  'use strict';

  const MAX_DOC_BYTES = 900000; // 900KB safety margin under 1MB limit

  function getApi(){
    return root.firebaseApi || null;
  }

  function estimateDocSize(obj){
    try { return JSON.stringify(obj).length * 2; } catch{ return 0; }
  }

  /**
   * FirestoreRepo: normalized CRUD for the new wizard data schema.
   *
   * All paths are relative to users/{uid}/.
   * This module knows nothing about localStorage — it's pure Firestore.
   */
  class FirestoreRepo {
    constructor(opts = {}){
      this._telemetry = opts.telemetry || null;
    }

    _api(){
      const api = getApi();
      if(!api?.db || !api?.doc || !api?.getDoc || !api?.setDoc){
        return null;
      }
      return api;
    }

    _requireApi(){
      const api = this._api();
      if(!api) throw new Error('Firebase API not available');
      return api;
    }

    _userDocRef(api, uid, ...pathSegments){
      return api.doc(api.db, 'users', uid, ...pathSegments);
    }

    // ---- Profile (meta) ----

    async getProfile(uid){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'meta', 'profile');
      const snap = await api.getDoc(ref);
      this._trackRead('meta/profile');
      return snap.exists() ? snap.data() : null;
    }

    async setProfile(uid, data){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'meta', 'profile');
      const payload = { ...data, updatedAt: api.serverTimestamp() };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite('meta/profile', payload);
    }

    // ---- Wizards ----

    async getWizard(uid, wizardId){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId);
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}`);
      return snap.exists() ? snap.data() : null;
    }

    async setWizard(uid, wizardId, data){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId);
      const payload = {
        ...data,
        wizardId,
        updatedAt: api.serverTimestamp(),
        version: (data.version || 0) + 1
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite(`wizards/${wizardId}`, payload);
    }

    async deleteWizard(uid, wizardId){
      const api = this._requireApi();
      // Firestore doesn't have cascading deletes from client SDK
      // We mark as deleted and clean up subcollections
      const ref = this._userDocRef(api, uid, 'wizards', wizardId);
      await api.setDoc(ref, { status: 'deleted', updatedAt: api.serverTimestamp() }, { merge: true });
      this._trackWrite(`wizards/${wizardId}`, { status: 'deleted' });
    }

    // ---- Layouts ----

    async getLayout(uid, wizardId, layoutId){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'layouts', layoutId);
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}/layouts/${layoutId}`);
      return snap.exists() ? snap.data() : null;
    }

    async setLayout(uid, wizardId, layoutId, data){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'layouts', layoutId);
      const payload = {
        ...data,
        layoutId,
        updatedAt: api.serverTimestamp(),
        version: (data.version || 0) + 1
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite(`wizards/${wizardId}/layouts/${layoutId}`, payload);
    }

    // ---- Fields ----

    async getField(uid, wizardId, layoutId, fieldKey){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'layouts', layoutId, 'fields', fieldKey);
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}/layouts/${layoutId}/fields/${fieldKey}`);
      return snap.exists() ? snap.data() : null;
    }

    async setField(uid, wizardId, layoutId, fieldKey, data){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'layouts', layoutId, 'fields', fieldKey);
      const payload = {
        ...data,
        fieldKey,
        updatedAt: api.serverTimestamp(),
        version: (data.version || 0) + 1
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite(`wizards/${wizardId}/layouts/${layoutId}/fields/${fieldKey}`, payload);
    }

    // ---- Pattern Bundles ----

    async getPatternBundle(uid, wizardId, layoutId){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'patterns', layoutId);
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}/patterns/${layoutId}`);
      if(!snap.exists()) return null;
      const data = snap.data();
      // Check for chunked pattern
      if(data._chunked){
        return this._readChunkedPattern(uid, wizardId, layoutId, data._chunkCount);
      }
      return data;
    }

    async setPatternBundle(uid, wizardId, layoutId, patternData){
      const api = this._requireApi();
      const sizeBytes = estimateDocSize(patternData);

      if(sizeBytes > MAX_DOC_BYTES){
        // Chunk the pattern bundle
        await this._writeChunkedPattern(uid, wizardId, layoutId, patternData, sizeBytes);
      } else {
        const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'patterns', layoutId);
        const payload = {
          layoutId,
          patternData,
          updatedAt: api.serverTimestamp(),
          sizeBytes,
          _chunked: false
        };
        await api.setDoc(ref, payload, { merge: true });
        this._trackWrite(`wizards/${wizardId}/patterns/${layoutId}`, payload);
      }
    }

    async _writeChunkedPattern(uid, wizardId, layoutId, patternData, totalSize){
      const api = this._requireApi();
      const serialized = JSON.stringify(patternData);
      const chunkSize = MAX_DOC_BYTES / 2; // ~450KB per chunk
      const chunks = [];
      for(let i = 0; i < serialized.length; i += chunkSize){
        chunks.push(serialized.slice(i, i + chunkSize));
      }

      // Write header doc
      const headerRef = this._userDocRef(api, uid, 'wizards', wizardId, 'patterns', layoutId);
      await api.setDoc(headerRef, {
        layoutId,
        _chunked: true,
        _chunkCount: chunks.length,
        updatedAt: api.serverTimestamp(),
        sizeBytes: totalSize
      }, { merge: true });

      // Write chunk docs
      for(let i = 0; i < chunks.length; i++){
        const chunkRef = this._userDocRef(api, uid, 'wizards', wizardId, 'patterns', layoutId, 'chunks', `chunk_${i}`);
        await api.setDoc(chunkRef, { index: i, data: chunks[i] });
      }
      this._trackWrite(`wizards/${wizardId}/patterns/${layoutId}`, { chunked: true, chunkCount: chunks.length, sizeBytes: totalSize });
    }

    async _readChunkedPattern(uid, wizardId, layoutId, chunkCount){
      const api = this._requireApi();
      const parts = [];
      for(let i = 0; i < chunkCount; i++){
        const chunkRef = this._userDocRef(api, uid, 'wizards', wizardId, 'patterns', layoutId, 'chunks', `chunk_${i}`);
        const snap = await api.getDoc(chunkRef);
        if(!snap.exists()) throw new Error(`Missing pattern chunk ${i} for ${layoutId}`);
        parts.push(snap.data().data);
        this._trackRead(`wizards/${wizardId}/patterns/${layoutId}/chunks/chunk_${i}`);
      }
      return { patternData: JSON.parse(parts.join('')) };
    }

    // ---- Master DB ----

    async getMasterDb(uid, wizardId){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'masterDb', 'current');
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}/masterDb/current`);
      return snap.exists() ? snap.data() : null;
    }

    async setMasterDb(uid, wizardId, entries){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'masterDb', 'current');
      const payload = {
        entries: Array.isArray(entries) ? entries : [],
        updatedAt: api.serverTimestamp(),
        entryCount: Array.isArray(entries) ? entries.length : 0,
        version: Date.now()
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite(`wizards/${wizardId}/masterDb/current`, payload);
    }

    // ---- Master DB Rows ----

    async getMasterDbRows(uid, wizardId){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'masterDbRows', 'current');
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}/masterDbRows/current`);
      return snap.exists() ? snap.data() : null;
    }

    async setMasterDbRows(uid, wizardId, rowsPayload){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'masterDbRows', 'current');
      const payload = {
        ...rowsPayload,
        updatedAt: api.serverTimestamp(),
        version: Date.now()
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite(`wizards/${wizardId}/masterDbRows/current`, payload);
    }

    // ---- Chart Ready ----

    async getChartReady(uid, wizardId){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'chartReady', 'current');
      const snap = await api.getDoc(ref);
      this._trackRead(`wizards/${wizardId}/chartReady/current`);
      return snap.exists() ? snap.data() : null;
    }

    async setChartReady(uid, wizardId, data){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'wizards', wizardId, 'chartReady', 'current');
      const payload = { data, updatedAt: api.serverTimestamp() };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite(`wizards/${wizardId}/chartReady/current`, payload);
    }

    // ---- Templates ----

    async getTemplates(uid){
      const api = this._requireApi();
      // Read all templates (collection read)
      // For now, store as single doc for simplicity
      const ref = this._userDocRef(api, uid, 'templates', '_all');
      const snap = await api.getDoc(ref);
      this._trackRead('templates/_all');
      return snap.exists() ? (snap.data().items || []) : [];
    }

    async setTemplates(uid, templates){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'templates', '_all');
      const payload = {
        items: Array.isArray(templates) ? templates : [],
        updatedAt: api.serverTimestamp()
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite('templates/_all', payload);
    }

    // ---- Models ----

    async getModels(uid){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'models', '_all');
      const snap = await api.getDoc(ref);
      this._trackRead('models/_all');
      return snap.exists() ? (snap.data().items || []) : [];
    }

    async setModels(uid, models){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'models', '_all');
      const payload = {
        items: Array.isArray(models) ? models : [],
        updatedAt: api.serverTimestamp()
      };
      await api.setDoc(ref, payload, { merge: true });
      this._trackWrite('models/_all', payload);
    }

    // ---- OCR Segments ----

    async getOcrSegments(uid){
      const api = this._requireApi();
      const ref = this._userDocRef(api, uid, 'ocrSegments', 'current');
      const snap = await api.getDoc(ref);
      this._trackRead('ocrSegments/current');
      if(!snap.exists()) return null;
      const data = snap.data();
      if(data._chunked){
        return this._readChunkedOcr(uid, data._chunkCount);
      }
      return data;
    }

    async setOcrSegments(uid, segmentStore, segmentStoreChunks){
      const api = this._requireApi();
      const payload = { segmentStore, segmentStoreChunks };
      const sizeBytes = estimateDocSize(payload);

      if(sizeBytes > MAX_DOC_BYTES){
        // Chunk it
        const serialized = JSON.stringify(payload);
        const chunkSize = MAX_DOC_BYTES / 2;
        const chunks = [];
        for(let i = 0; i < serialized.length; i += chunkSize){
          chunks.push(serialized.slice(i, i + chunkSize));
        }
        const headerRef = this._userDocRef(api, uid, 'ocrSegments', 'current');
        await api.setDoc(headerRef, {
          _chunked: true,
          _chunkCount: chunks.length,
          updatedAt: api.serverTimestamp(),
          sizeBytes
        });
        for(let i = 0; i < chunks.length; i++){
          const chunkRef = this._userDocRef(api, uid, 'ocrSegments', 'current', 'chunks', `chunk_${i}`);
          await api.setDoc(chunkRef, { index: i, data: chunks[i] });
        }
      } else {
        const ref = this._userDocRef(api, uid, 'ocrSegments', 'current');
        await api.setDoc(ref, {
          ...payload,
          _chunked: false,
          updatedAt: api.serverTimestamp(),
          sizeBytes
        }, { merge: true });
      }
      this._trackWrite('ocrSegments/current', { sizeBytes });
    }

    async _readChunkedOcr(uid, chunkCount){
      const api = this._requireApi();
      const parts = [];
      for(let i = 0; i < chunkCount; i++){
        const chunkRef = this._userDocRef(api, uid, 'ocrSegments', 'current', 'chunks', `chunk_${i}`);
        const snap = await api.getDoc(chunkRef);
        if(!snap.exists()) throw new Error(`Missing OCR chunk ${i}`);
        parts.push(snap.data().data);
        this._trackRead(`ocrSegments/current/chunks/chunk_${i}`);
      }
      return JSON.parse(parts.join(''));
    }

    // ---- Batch write support ----

    async batchWrite(uid, operations){
      const api = this._requireApi();
      // Firestore batched writes (max 500 operations)
      // operations: [{ path: [segments], data: obj, type: 'set'|'delete' }]
      if(!api.writeBatch){
        // Fallback: sequential writes
        for(const op of operations){
          const ref = this._userDocRef(api, uid, ...op.path);
          if(op.type === 'delete'){
            // Client SDK delete not available in our exports, use status marker
            await api.setDoc(ref, { _deleted: true, updatedAt: api.serverTimestamp() });
          } else {
            await api.setDoc(ref, { ...op.data, updatedAt: api.serverTimestamp() }, { merge: true });
          }
        }
        this._trackWrite('batch', { opCount: operations.length });
        return;
      }
      const batch = api.writeBatch(api.db);
      for(const op of operations){
        const ref = this._userDocRef(api, uid, ...op.path);
        if(op.type === 'delete'){
          batch.delete(ref);
        } else {
          batch.set(ref, { ...op.data, updatedAt: api.serverTimestamp() }, { merge: true });
        }
      }
      await batch.commit();
      this._trackWrite('batch', { opCount: operations.length });
    }

    // ---- Telemetry helpers ----

    _trackRead(path){
      if(this._telemetry) this._telemetry.increment('firestoreReads');
    }

    _trackWrite(path, payload){
      if(this._telemetry){
        this._telemetry.increment('firestoreWrites');
        const sizeBytes = payload?.sizeBytes || estimateDocSize(payload);
        this._telemetry.recordPayloadSize('firestoreWrite', path, sizeBytes);
      }
    }
  }

  if(typeof module === 'object' && module.exports){
    module.exports = FirestoreRepo;
  } else {
    root.FirestoreRepo = FirestoreRepo;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
