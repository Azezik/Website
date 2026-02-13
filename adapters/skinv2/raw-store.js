(function(root){
  function createSkinV2RawStore(deps){
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

  root.SkinV2RawStoreAdapter = { createSkinV2RawStore };
})(typeof window !== 'undefined' ? window : globalThis);
