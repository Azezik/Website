(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaticResolverRollout = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  function resolveFlag(opts = {}){
    const { windowOverride = null, env = null, enabled } = opts;
    if(enabled === true || enabled === false){ return !!enabled; }
    const w = windowOverride || (typeof window !== 'undefined' ? window : {});
    if(w && w.FEATURE_STATIC_RESOLVER_ALL !== undefined){ return !!w.FEATURE_STATIC_RESOLVER_ALL; }
    const envVars = env || (typeof process !== 'undefined' ? process.env : {});
    const envSetting = envVars ? envVars.STATIC_RESOLVER_ALL : undefined;
    if(envSetting !== undefined){
      if(String(envSetting).toLowerCase() === 'false' || envSetting === '0') return false;
      if(String(envSetting).toLowerCase() === 'true' || envSetting === '1') return true;
    }
    return true;
  }

  function isEnabled(opts = {}){
    return resolveFlag(opts);
  }

  return { isEnabled, resolveFlag };
});
