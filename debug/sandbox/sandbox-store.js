(function(root){
  function clonePlain(value){
    if(value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }

  function createSandboxStores(deps){
    const profileStore = deps?.profileStore;
    const rawStore = deps?.rawStore;

    const profileMap = new Map();
    const rawMap = new Map();

    return {
      profileStore: {
        loadProfile(username, docType, wizardId, geometryId){
          const key = JSON.stringify([username || '', docType || '', wizardId || '', geometryId || '']);
          if(profileMap.has(key)) return clonePlain(profileMap.get(key));
          const loaded = profileStore?.loadProfile ? profileStore.loadProfile(username, docType, wizardId, geometryId) : null;
          const cloned = clonePlain(loaded);
          profileMap.set(key, cloned);
          return clonePlain(cloned);
        },
        saveProfile(username, docType, profile, wizardId, geometryId){
          const key = JSON.stringify([username || '', docType || '', wizardId || '', geometryId || '']);
          profileMap.set(key, clonePlain(profile));
        },
        migrateProfile(profile){
          return profileStore?.migrateProfile ? profileStore.migrateProfile(profile) : profile;
        }
      },
      rawStore: {
        upsert(fileId, rec){
          if(!fileId) return;
          const items = rawMap.get(fileId) || [];
          const idx = items.findIndex(item => item?.fieldKey === rec?.fieldKey);
          if(idx >= 0) items[idx] = clonePlain(rec);
          else items.push(clonePlain(rec));
          rawMap.set(fileId, items);
        },
        getByFile(fileId){
          return clonePlain(rawMap.get(fileId) || []);
        },
        clearByFile(fileId){
          rawMap.delete(fileId);
        }
      }
    };
  }

  root.DebugSandboxStore = { createSandboxStores };
})(typeof window !== 'undefined' ? window : globalThis);
