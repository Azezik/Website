(function(root){
  function createLegacyExtractionRuntime(deps){
    const { tokenProvider, profileStore, rawStore, compileEngine } = deps || {};
    if(root.EngineExtraction?.createExtractionEngine){
      return root.EngineExtraction.createExtractionEngine({ tokenProvider, profileStore, rawStore, compileEngine: compileEngine || root.EngineCompile || null });
    }
    return null;
  }

  root.LegacyExtractionRuntimeAdapter = { createLegacyExtractionRuntime };
})(typeof window !== 'undefined' ? window : globalThis);
