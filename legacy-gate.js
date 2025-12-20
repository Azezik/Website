(function () {
  const FLAG_KEY = 'wrokitLegacy';
  let inMemoryFlag = false;

  function markLegacyEntry() {
    try {
      sessionStorage.setItem(FLAG_KEY, '1');
    } catch (err) {
      inMemoryFlag = true;
    }
  }

  function requireLegacyFlag() {
    try {
      if (!sessionStorage.getItem(FLAG_KEY)) {
        window.location.href = '/legacy/';
      }
    } catch (err) {
      if (!inMemoryFlag) {
        window.location.href = '/legacy/';
      }
    }
  }

  window.wrokitLegacyGate = {
    markLegacyEntry,
    requireLegacyFlag,
  };
})();
