(() => {
  const form = document.querySelector('form.auth');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');

  if (!form || !usernameInput) return;

  function completeLoginFromHome(event) {
    event.preventDefault();
    const username = (usernameInput.value || '').trim() || 'demo';
    const docType = 'invoice';
    const payload = {
      username,
      docType,
      wizardId: '',
    };
    if (window.SessionStore?.setActiveSession) {
      window.SessionStore.setActiveSession(payload);
    }
    const params = new URLSearchParams();
    params.set('username', username);
    params.set('docType', docType);
    window.location.href = `/document-dashboard.html?${params.toString()}`;
  }

  form.addEventListener('submit', completeLoginFromHome);
})();
