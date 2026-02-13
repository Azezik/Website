(function(root){
  function createSkinV2ProfileStore(deps){
    const { loadProfile, saveProfile, migrateProfile } = deps || {};
    return {
      loadProfile(username, docType, wizardId, geometryId){
        return loadProfile ? loadProfile(username, docType, wizardId, geometryId) : null;
      },
      saveProfile(username, docType, profile, wizardId, geometryId){
        if(saveProfile) saveProfile(username, docType, profile, wizardId, geometryId);
      },
      migrateProfile(profile){
        return migrateProfile ? migrateProfile(profile) : profile;
      }
    };
  }

  root.SkinV2ProfileStoreAdapter = { createSkinV2ProfileStore };
})(typeof window !== 'undefined' ? window : globalThis);
