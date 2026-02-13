(function(root){
  function createLegacyRawStore(deps){
    if(root.SkinV2RawStoreAdapter?.createSkinV2RawStore){
      return root.SkinV2RawStoreAdapter.createSkinV2RawStore(deps);
    }

    const { rawMap } = deps || {};
    return {
      upsert(fileId, rec){
        rawMap?.upsert(fileId, rec);
      },
      getByFile(fileId){
        return rawMap?.get(fileId) || [];
      },
      clearByFile(fileId){
        rawMap?.clear(fileId);
      }
    };
  }

  root.LegacyRawStoreAdapter = { createLegacyRawStore };
})(typeof window !== 'undefined' ? window : globalThis);
