/**
 * engine-log.js — Minimal shared logging helper for engine observability.
 *
 * Provides a single `engineLog(channel, stage, payload)` function with:
 *   - Always-on console.info / console.warn (never console.debug)
 *   - Consistent [channel] stage prefix for DevTools filter-bar queries
 *   - Monotonic seq id on every entry for ordering across async boundaries
 *
 * Channels and their console level:
 *   engine      → info   (engine resolution, wizard save/load)
 *   dispatch    → info   (registry routing decisions)
 *   wfg4-cfg    → info   (config-time WFG4: OpenCV, registration, persist)
 *   wfg4-run    → info   (run-time WFG4: surface, localize, gate, readout)
 *   legacy      → warn   (legacy path entered when a non-legacy engine expected)
 */
(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.EngineLog = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  let _seq = 0;
  const _warnChannels = new Set(['legacy']);

  function engineLog(channel, stage, payload){
    const seq = ++_seq;
    const label = '[' + channel + '] ' + stage;
    const data = Object.assign({ seq: seq }, payload || {});
    if(_warnChannels.has(channel)){
      // eslint-disable-next-line no-console
      console.warn(label, data);
    } else {
      // eslint-disable-next-line no-console
      console.info(label, data);
    }
  }

  return { engineLog: engineLog };
});
