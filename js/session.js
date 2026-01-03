(function(global){
  const SESSION_KEY = 'wiz.session';

  function read(){
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(err){
      console.warn('[session] failed to read', err);
      return null;
    }
  }

  function write(payload){
    try {
      if(!payload){
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      const normalized = {
        username: (payload.username || '').trim() || 'demo',
        docType: payload.docType || 'invoice',
        wizardId: payload.wizardId || '',
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(normalized));
      return normalized;
    } catch(err){
      console.warn('[session] failed to write', err);
      return null;
    }
  }

  const SessionStore = {
    getActiveSession: read,
    setActiveSession: write,
    clearActiveSession(){ write(null); }
  };

  global.SessionStore = SessionStore;
})(typeof window !== 'undefined' ? window : this);
