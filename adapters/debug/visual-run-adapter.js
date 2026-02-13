(function(root){
  function createVisualRunAdapter(deps = {}){
    function getFactory(){
      return deps.contextFactory || root.DebugSandboxContextFactory?.createContextFactory?.();
    }
    return {
      beginSession(){
        const contextFactory = getFactory();
        return contextFactory?.begin ? contextFactory.begin('visual-run') : null;
      },
      endSession(session){
        const contextFactory = getFactory();
        if(contextFactory?.end) contextFactory.end(session);
      }
    };
  }

  root.DebugVisualRunAdapter = { createVisualRunAdapter };
})(typeof window !== 'undefined' ? window : globalThis);
