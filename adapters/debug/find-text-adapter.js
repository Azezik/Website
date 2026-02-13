(function(root){
  function createFindTextAdapter(deps = {}){
    function getFactory(){
      return deps.contextFactory || root.DebugSandboxContextFactory?.createContextFactory?.();
    }
    return {
      beginSession(){
        const contextFactory = getFactory();
        return contextFactory?.begin ? contextFactory.begin('find-text') : null;
      },
      endSession(session){
        const contextFactory = getFactory();
        if(contextFactory?.end) contextFactory.end(session);
      }
    };
  }

  root.DebugFindTextAdapter = { createFindTextAdapter };
})(typeof window !== 'undefined' ? window : globalThis);
