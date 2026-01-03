(() => {
  const form = document.querySelector('form.auth');
  const usernameInput = document.getElementById('username');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const signupBtn = document.getElementById('signup-btn');

  if (!form || !usernameInput) return;

  function performLogin(usernameOverride) {
    const username = (usernameOverride || usernameInput.value || '').trim() || 'demo';
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

  async function handleSignup(event) {
    event?.preventDefault?.();
    const username = (usernameInput.value || '').trim();
    if (!username) {
      alert('Please choose a username.');
      return;
    }
    const email = (emailInput?.value || '').trim();
    const password = passwordInput?.value || '';
    const api = window.firebaseApi;
    if (!api?.createUserWithEmailAndPassword || !api?.auth) {
      console.warn('[signup] firebase not available; falling back to local login');
      performLogin(username);
      return;
    }
    try {
      const cred = await api.createUserWithEmailAndPassword(api.auth, email, password);
      try {
        await api.persistUsernameMapping?.(cred.user.uid, username);
      } catch (err) {
        console.warn('[signup] failed to persist username mapping', err);
      }
      if (window.state) {
        window.state.username = username;
      }
      if (typeof window.completeLogin === 'function') {
        window.completeLogin({ username });
      } else {
        performLogin(username);
      }
    } catch (err) {
      console.error('[signup] failed', err);
      alert(err?.message || 'Sign up failed. Please try again.');
    }
  }

  function completeLoginFromHome(event) {
    event.preventDefault();
    performLogin();
  }

  form.addEventListener('submit', completeLoginFromHome);
  signupBtn?.addEventListener('click', handleSignup);
})();
