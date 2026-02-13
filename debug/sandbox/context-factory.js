(function(root){
  function createContextFactory(deps = {}){
    const hooks = deps.hooks || root.__skinV2DebugSandboxHooks;
    if(!hooks) return null;

    function begin(kind = 'debug'){
      const snapshot = hooks.captureCoreState ? hooks.captureCoreState() : null;
      const stores = root.DebugSandboxStore?.createSandboxStores
        ? root.DebugSandboxStore.createSandboxStores({
            profileStore: hooks.getProfileStoreContract?.(),
            rawStore: hooks.getRawStoreContract?.()
          })
        : null;
      if(stores?.profileStore && hooks.setProfileStoreContract){
        hooks.setProfileStoreContract(stores.profileStore);
      }
      if(stores?.rawStore && hooks.setRawStoreContract){
        hooks.setRawStoreContract(stores.rawStore);
      }
      return { kind, snapshot };
    }

    function end(session){
      hooks.setProfileStoreContract?.(null);
      hooks.setRawStoreContract?.(null);
      if(session?.snapshot && hooks.restoreCoreState){
        hooks.restoreCoreState(session.snapshot);
      }
    }

    async function run(kind, fn){
      const session = begin(kind);
      try {
        return await fn(session);
      } finally {
        end(session);
      }
    }

    return { begin, end, run };
  }

  root.DebugSandboxContextFactory = { createContextFactory };
})(typeof window !== 'undefined' ? window : globalThis);
