(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.WrokitEngineRegistry = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function(root){
  const ENGINE_KIND = {
    LEGACY: 'legacy',
    AI_ALGO: 'ai_algo',
    WROKIT_VISION: 'wrokit_vision',
    WFG4: 'wfg4'
  };

  function normalizeEngineType(raw){
    const value = String(raw || '').toLowerCase().trim();
    if(value === 'ai') return ENGINE_KIND.AI_ALGO;
    if(value === ENGINE_KIND.LEGACY || value === ENGINE_KIND.AI_ALGO || value === ENGINE_KIND.WROKIT_VISION || value === ENGINE_KIND.WFG4){
      return value;
    }
    return ENGINE_KIND.LEGACY;
  }

  function createRuntime(engineType, deps = {}){
    const kind = normalizeEngineType(engineType);
    if(kind === ENGINE_KIND.LEGACY){
      if(root.LegacyExtractionRuntimeAdapter?.createLegacyExtractionRuntime){
        return root.LegacyExtractionRuntimeAdapter.createLegacyExtractionRuntime(deps);
      }
      return root.EngineExtraction?.createExtractionEngine
        ? root.EngineExtraction.createExtractionEngine(deps)
        : null;
    }
    if(kind === ENGINE_KIND.WFG4){
      // Phase 1 scaffold: WFG4 uses the same run orchestrator contract as other
      // engines; field-level behavior is delegated via extractScalar/registerField.
      return root.EngineExtraction?.createExtractionEngine
        ? root.EngineExtraction.createExtractionEngine(deps)
        : null;
    }
    if(root.EngineExtraction?.createExtractionEngine){
      return root.EngineExtraction.createExtractionEngine(deps);
    }
    return null;
  }

  async function registerFieldConfig(engineType, payload = {}){
    const kind = normalizeEngineType(engineType);
    if(kind === ENGINE_KIND.AI_ALGO){
      return root.AIExtractionEngine?.registerField
        ? { aiConfig: root.AIExtractionEngine.registerField(payload) }
        : {};
    }
    if(kind === ENGINE_KIND.WROKIT_VISION){
      return root.WrokitVisionEngine?.registerField
        ? { wrokitVisionConfig: root.WrokitVisionEngine.registerField(payload) }
        : {};
    }
    if(kind === ENGINE_KIND.WFG4){
      return root.WFG4Engine?.registerField
        ? { wfg4Config: await root.WFG4Engine.registerField(payload) }
        : {};
    }
    return {};
  }

  function extractScalar(engineType, payload = {}){
    const kind = normalizeEngineType(engineType);
    if(kind === ENGINE_KIND.AI_ALGO && root.AIExtractionEngine?.extractScalar){
      return root.AIExtractionEngine.extractScalar(payload);
    }
    if(kind === ENGINE_KIND.WROKIT_VISION && root.WrokitVisionEngine?.extractScalar){
      return root.WrokitVisionEngine.extractScalar(payload);
    }
    if(kind === ENGINE_KIND.WFG4 && root.WFG4Engine?.extractScalar){
      return root.WFG4Engine.extractScalar(payload);
    }
    return null;
  }

  return {
    ENGINE_KIND,
    normalizeEngineType,
    createRuntime,
    registerFieldConfig,
    extractScalar
  };
});
