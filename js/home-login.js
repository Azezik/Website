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

  function bootstrapAuthSession() {
    const api = window.firebaseApi;
    if (!api?.onAuthStateChanged || !api?.auth) return;
    api.onAuthStateChanged(api.auth, async (user) => {
      if (!user) return;
      let username = '';
      try {
        const meta = await api.fetchUserMeta?.(user.uid);
        if (meta?.usernameDisplay || meta?.usernameLower) {
          username = meta.usernameDisplay || meta.usernameLower;
        }
      } catch (err) {
        console.warn('[auth] failed to fetch username mapping', err);
      }
      if (!username) {
        console.warn('[auth] username mapping missing; skip auto-login');
        return;
      }
      performLogin(username);
    });
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
        const claimed = await api.claimUsername?.(cred.user.uid, username, email);
        const resolvedUsername = claimed?.usernameDisplay || claimed?.usernameLower || username;
        if (window.state) {
          window.state.username = resolvedUsername;
        }
        if (typeof window.completeLogin === 'function') {
          window.completeLogin({ username: resolvedUsername });
        } else {
          performLogin(resolvedUsername);
        }
        return;
      } catch (err) {
        console.error('[signup] failed to persist username mapping', err);
        try { await api.signOut?.(api.auth); } catch(signOutErr){ console.warn('[signup] signOut after failure failed', signOutErr); }
        alert(err?.message || 'Username is already taken or could not be saved.');
        return;
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
  bootstrapAuthSession();
})();
