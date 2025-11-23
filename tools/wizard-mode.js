(function(root, factory){
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.WizardMode = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
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
    state.pageOffsets = [];
    state.pageViewports = [];
    state.pageRenderPromises = [];
    state.pageRenderReady = [];
    state.pageSnapshots = {};
    state.tokensByPage = {};
    state.currentLineItems = [];
    state.currentFileId = '';
    state.currentFileName = '';
    state.lineLayout = null;
    return state;
  }

  function enterRunModeState(state){
    clearTransientState(state);
    if(state) state.mode = 'RUN';
    return state;
  }

  function enterConfigModeState(state){
    clearTransientState(state);
    if(state) state.mode = 'CONFIG';
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

  return { clearTransientState, enterRunModeState, enterConfigModeState, createRunLoopGuard, runKeyForFile };
});
