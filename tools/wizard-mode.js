(function(root, factory){
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.WizardMode = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const WizardMode = Object.freeze({ CONFIG: 'CONFIG', RUN: 'RUN' });
  function clearTransientState(state){
    if(!state) return state;
    state.stepIdx = 0;
    state.steps = [];
    state.selectionCss = null;
    state.selectionPx = null;
    state.snappedCss = null;
    state.snappedPx = null;
    state.snappedText = '';
    state.pendingSelection = null;
    state.matchPoints = [];
    state.overlayMetrics = null;
    state.overlayPinned = false;
    state.pdf = null;
    state.isImage = false;
    state.pageNum = 1;
    state.numPages = 0;
    state.viewport = { w:0, h:0, scale:1 };
    state.pageOffsets = [];
    state.pageViewports = [];
    state.pageRenderPromises = [];
    state.pageRenderReady = [];
    state.pageSnapshots = {};
    state.grayCanvases = {};
    state.telemetry = [];
    state.currentTraceId = null;
    state.lastOcrCropPx = null;
    state.lastOcrCropCss = null;
    state.cropAudits = [];
    state.cropHashes = {};
    state.tokensByPage = {};
    state.currentLineItems = [];
    state.currentFileId = '';
    state.currentFileName = '';
    state.lineLayout = null;
    return state;
  }

  function enterRunModeState(state){
    clearTransientState(state);
    if(state) state.mode = WizardMode.RUN;
    return state;
  }

  function enterConfigModeState(state){
    clearTransientState(state);
    if(state) state.mode = WizardMode.CONFIG;
    return state;
  }

  function runKeyForFile(file){
    if(!file) return '';
    const name = file.name || '';
    const size = Number.isFinite(file.size) ? file.size : 0;
    const mtime = Number.isFinite(file.lastModified) ? file.lastModified : 0;
    return `${name}::${size}::${mtime}`;
  }

  function createRunLoopGuard(){
    const activeKeys = new Set();
    return {
      start(key){
        if(!key) return true;
        if(activeKeys.has(key)) return false;
        activeKeys.add(key);
        return true;
      },
      finish(key){
        if(!key) return;
        activeKeys.delete(key);
      },
      isActive:(key)=>activeKeys.has(key)
    };
  }

  function createRunDiagnostics(){
    const extractionStarts = new Map();
    const extractionFinishes = new Map();
    const modeSyncCounts = new Map();
    return {
      startExtraction(key){
        if(!key) return 0;
        const next = (extractionStarts.get(key) || 0) + 1;
        extractionStarts.set(key, next);
        return next;
      },
      finishExtraction(key){
        if(!key) return 0;
        const next = (extractionFinishes.get(key) || 0) + 1;
        extractionFinishes.set(key, next);
        return next;
      },
      noteModeSync(label){
        const next = (modeSyncCounts.get(label) || 0) + 1;
        modeSyncCounts.set(label, next);
        return next;
      },
      shouldThrottleModeSync(label, limit=5){
        return (modeSyncCounts.get(label) || 0) >= limit;
      },
      reset(){
        extractionStarts.clear();
        extractionFinishes.clear();
        modeSyncCounts.clear();
      },
      stats(){
        const obj = m => Object.fromEntries(Array.from(m.entries()));
        return {
          extractionStarts: obj(extractionStarts),
          extractionFinishes: obj(extractionFinishes),
          modeSyncCounts: obj(modeSyncCounts)
        };
      }
    };
  }

  function createModeController(logger = console){
    const guard = createRunLoopGuard();
    let mode = WizardMode.CONFIG;
    return {
      WizardMode,
      setMode(next){ mode = next === WizardMode.RUN ? WizardMode.RUN : WizardMode.CONFIG; },
      getMode(){ return mode; },
      isRun(){ return mode === WizardMode.RUN; },
      guardInteractive(label, opts={}){
        const allowInRun = !!opts.allowInRun;
        if(mode !== WizardMode.RUN || allowInRun) return false;
        if(logger && typeof logger.warn === 'function'){
          logger.warn(`[run-mode] ${label} invoked while in RUN mode; skipping.`);
        }
        return true;
      },
      trackRun(fileKey, work){
        if(!guard.start(fileKey)){
          if(logger && typeof logger.warn === 'function'){
            logger.warn(`Duplicate run blocked for ${fileKey}`);
          }
          return Promise.resolve();
        }
        const finish = ()=>guard.finish(fileKey);
        try {
          const res = work();
          return Promise.resolve(res).finally(finish);
        } catch(err){
          finish();
          throw err;
        }
      }
    };
  }

  return { clearTransientState, enterRunModeState, enterConfigModeState, createRunLoopGuard, createRunDiagnostics, runKeyForFile, WizardMode, createModeController };
});
