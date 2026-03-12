(function(root){
  const FIRESTORE_FLAG_KEY = 'wrokit.firestorePrimary';
  const pendingCloudSaves = [];
  let cloudBootstrapPromise = null;

  function isCloudSyncEnabled(service){
    if(service?.isFirestoreEnabled) return true;
    try {
      return root.localStorage?.getItem(FIRESTORE_FLAG_KEY) === '1';
    } catch{
      return false;
    }
  }

  function sanitizeForFirestore(value){
    return JSON.parse(JSON.stringify(value, (key, current) => {
      if(current === undefined) return undefined;
      if(key === 'landmark') return undefined;
      if(key === 'ringMask' || key === 'edgePatch') return undefined;
      if(ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return undefined;
      return current;
    }));
  }

  function getDataLayerService(){
    return root._wrokitDataLayer?.service || null;
  }

  function getCloudUid(service){
    return root.firebaseApi?.auth?.currentUser?.uid || service?._uid || null;
  }

  async function flushPendingCloudSaves(legacySaveProfile){
    const service = getDataLayerService();
    const uid = getCloudUid(service);
    if(!service?.saveProfile || !uid) return { flushed: 0, ready: false };
    let flushed = 0;
    while(pendingCloudSaves.length){
      const entry = pendingCloudSaves.shift();
      try {
        await service.saveProfile(uid, entry.payload);
        if(typeof legacySaveProfile === 'function' && entry.localArgs){
          legacySaveProfile(...entry.localArgs);
        }
        flushed += 1;
      } catch(err){
        console.warn('[profile-store] deferred cloud profile save failed', err);
      }
    }
    return { flushed, ready: true };
  }

  function queueCloudSave(entry){
    pendingCloudSaves.push(entry);
  }

  function scheduleCloudBootstrap(username, legacySaveProfile){
    if(cloudBootstrapPromise) return cloudBootstrapPromise;
    cloudBootstrapPromise = Promise.resolve().then(async ()=>{
      if(!root._wrokitDataLayer && root.WrokitDataLayer?.create){
        root._wrokitDataLayer = root.WrokitDataLayer.create();
      }
      const service = getDataLayerService();
      if(!service){
        return { ready: false, reason: 'no-service' };
      }
      if(!service.isReady){
        const uid = getCloudUid(service);
        if(uid && username && root._wrokitDataLayer?.init){
          try {
            await root._wrokitDataLayer.init(uid, username);
            console.info('[profile-store] cloud data layer initialized on-demand', { uid, username });
          } catch(err){
            console.warn('[profile-store] on-demand cloud data layer init failed', err);
          }
        }
      }
      const result = await flushPendingCloudSaves(legacySaveProfile);
      return { ready: result.ready, reason: result.ready ? 'flushed' : 'not-ready' };
    }).finally(()=>{
      cloudBootstrapPromise = null;
    });
    return cloudBootstrapPromise;
  }

  function saveViaCloudSync(username, docType, profile, wizardId, geometryId, legacySaveProfile){
    const service = getDataLayerService();
    if(!isCloudSyncEnabled(service)) return { handled: false, reason: 'cloud-disabled' };

    const payload = sanitizeForFirestore({
      username,
      docType,
      wizardId: wizardId || 'default',
      geometryId: geometryId || null,
      profile
    });

    const uid = getCloudUid(service);
    const localArgs = [username, docType, profile, wizardId, geometryId];
    if(service?.saveProfile && uid){
      Promise.resolve(service.saveProfile(uid, payload)).catch((err)=>{
        console.warn('[profile-store] cloud profile save failed', err);
      });
      // Keep local profile persistence in sync for Wizard Manager / run-mode readers.
      if(typeof legacySaveProfile === 'function') legacySaveProfile(...localArgs);
      return { handled: true, reason: 'cloud-save-enqueued' };
    }

    // Cloud sync is enabled but bootstrap/auth timing is not ready yet.
    queueCloudSave({ payload, localArgs });
    scheduleCloudBootstrap(username, legacySaveProfile).catch((err)=>{
      console.warn('[profile-store] deferred cloud bootstrap failed', err);
    });

    if(!service?.saveProfile){
      console.warn('[profile-store] cloud sync enabled but data layer is not ready yet; deferring profile save until bootstrap completes');
      return { handled: true, reason: 'cloud-deferred-no-service' };
    }

    console.warn('[profile-store] cloud sync enabled but uid is not ready yet; deferring profile save until auth/bootstrap completes');
    return { handled: true, reason: 'cloud-deferred-no-uid' };
  }

  function createSkinV2ProfileStore(deps){
    const { loadProfile, saveProfile, migrateProfile } = deps || {};
    return {
      loadProfile(username, docType, wizardId, geometryId){
        return loadProfile ? loadProfile(username, docType, wizardId, geometryId) : null;
      },
      saveProfile(username, docType, profile, wizardId, geometryId){
        const cloud = saveViaCloudSync(username, docType, profile, wizardId, geometryId, saveProfile);
        if(cloud?.handled) return;
        if(saveProfile) saveProfile(username, docType, profile, wizardId, geometryId);
      },
      migrateProfile(profile){
        return migrateProfile ? migrateProfile(profile) : profile;
      }
    };
  }

  root.SkinV2ProfileStoreAdapter = { createSkinV2ProfileStore };
})(typeof window !== 'undefined' ? window : globalThis);
