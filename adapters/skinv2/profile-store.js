(function(root){
  const FIRESTORE_FLAG_KEY = 'wrokit.firestorePrimary';

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

  function saveViaCloudSync(username, docType, profile, wizardId, geometryId){
    const dataLayer = root._wrokitDataLayer;
    const service = dataLayer?.service;
    if(!isCloudSyncEnabled(service)) return { handled: false, reason: 'cloud-disabled' };

    if(!service?.saveProfile){
      console.warn('[profile-store] cloud sync enabled but data layer is unavailable; falling back to legacy local profile save');
      return { handled: false, reason: 'cloud-enabled-no-service' };
    }

    const uid = root.firebaseApi?.auth?.currentUser?.uid || service?._uid;
    if(!uid){
      console.warn('[profile-store] cloud sync enabled but uid is unavailable; falling back to legacy local profile save');
      return { handled: false, reason: 'cloud-enabled-no-uid' };
    }

    const payload = sanitizeForFirestore({
      username,
      docType,
      wizardId: wizardId || 'default',
      geometryId: geometryId || null,
      profile
    });

    Promise.resolve(service.saveProfile(uid, payload)).catch((err)=>{
      console.warn('[profile-store] cloud profile save failed', err);
    });
    return { handled: true, reason: 'cloud-save-enqueued' };
  }

  function createSkinV2ProfileStore(deps){
    const { loadProfile, saveProfile, migrateProfile } = deps || {};
    return {
      loadProfile(username, docType, wizardId, geometryId){
        return loadProfile ? loadProfile(username, docType, wizardId, geometryId) : null;
      },
      saveProfile(username, docType, profile, wizardId, geometryId){
        const cloud = saveViaCloudSync(username, docType, profile, wizardId, geometryId);
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
