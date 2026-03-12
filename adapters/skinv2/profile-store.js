(function(root){
  function saveViaCloudSync(username, docType, profile, wizardId, geometryId){
    const dataLayer = root._wrokitDataLayer;
    const service = dataLayer?.service;
    if(!service?.isFirestoreEnabled) return false;

    const uid = root.firebaseApi?.auth?.currentUser?.uid || service?._uid;
    if(!uid){
      console.warn('[profile-store] cloud sync enabled but uid is unavailable; falling back to legacy local save');
      return false;
    }

    const payload = {
      username,
      docType,
      wizardId: wizardId || 'default',
      geometryId: geometryId || null,
      profile
    };

    Promise.resolve(service.saveProfile(uid, payload)).catch((err)=>{
      console.warn('[profile-store] cloud profile save failed', err);
    });
    return true;
  }

  function createSkinV2ProfileStore(deps){
    const { loadProfile, saveProfile, migrateProfile } = deps || {};
    return {
      loadProfile(username, docType, wizardId, geometryId){
        return loadProfile ? loadProfile(username, docType, wizardId, geometryId) : null;
      },
      saveProfile(username, docType, profile, wizardId, geometryId){
        if(saveViaCloudSync(username, docType, profile, wizardId, geometryId)) return;
        if(saveProfile) saveProfile(username, docType, profile, wizardId, geometryId);
      },
      migrateProfile(profile){
        return migrateProfile ? migrateProfile(profile) : profile;
      }
    };
  }

  root.SkinV2ProfileStoreAdapter = { createSkinV2ProfileStore };
})(typeof window !== 'undefined' ? window : globalThis);
