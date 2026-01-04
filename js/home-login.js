(() => {
  const form = document.querySelector('form.auth');
  const usernameInput = document.getElementById('username');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const signupBtn = document.getElementById('signup-btn');
  const loginBtn = form?.querySelector('button[type="submit"]');
  const statusEl = (() => {
    if (!form) return null;
    const el = document.createElement('p');
    el.id = 'login-status';
    el.className = 'sub';
    el.style.margin = '8px 0 0';
    el.style.minHeight = '18px';
    form.appendChild(el);
    return el;
  })();

  if (!form || !usernameInput) return;

  function setStatus(message, variant = 'info') {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.style.color = variant === 'error' ? '#b00020' : 'var(--muted)';
  }

  function setLoginPending(pending, message) {
    [usernameInput, emailInput, passwordInput, signupBtn, loginBtn].forEach((el) => {
      if (el) el.disabled = !!pending;
    });
    if (pending && message) {
      setStatus(message, 'info');
    } else if (!pending) {
      setStatus('');
    }
  }

  function waitForAuthUser(api, timeoutMs = 8000) {
    if (!api?.onAuthStateChanged || !api?.auth) {
      return Promise.reject(new Error('Firebase authentication is unavailable. Please try again later.'));
    }
    if (api.auth.currentUser) return Promise.resolve(api.auth.currentUser);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { unsubscribe?.(); } catch (err) { console.warn('[auth] unsubscribe failed after timeout', err); }
        reject(new Error('Login timed out while waiting for Firebase authentication. Please try again.'));
      }, timeoutMs);
      let unsubscribe = api.onAuthStateChanged(api.auth, (user) => {
        if (!user) return;
        clearTimeout(timeout);
        try { unsubscribe?.(); } catch (err) { console.warn('[auth] unsubscribe failed', err); }
        resolve(user);
      }, (err) => {
        clearTimeout(timeout);
        try { unsubscribe?.(); } catch (unsubErr) { console.warn('[auth] unsubscribe failed', unsubErr); }
        reject(err || new Error('Firebase authentication failed. Please try again.'));
      });
    });
  }

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

  async function hydrateFromAuthUser(user, usernameHint = '') {
    const api = window.firebaseApi;
    let username = (usernameHint || '').trim();
    if (!username) {
      try {
        const meta = await api?.fetchUserMeta?.(user.uid);
        if (meta?.usernameDisplay || meta?.usernameLower) {
          username = meta.usernameDisplay || meta.usernameLower;
        }
      } catch (err) {
        console.warn('[auth] failed to fetch username mapping', err);
      }
    }
    if (!username) {
      throw new Error('No username is linked to this account. Please contact support.');
    }
    console.info('[auth] login success', { hasAuth: !!api?.auth, hasUser: !!api?.auth?.currentUser, uid: user?.uid || null });
    performLogin(username);
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
    setLoginPending(true, 'Creating account...');
    const username = (usernameInput.value || '').trim();
    if (!username) {
      setLoginPending(false);
      alert('Please choose a username.');
      return;
    }
    const email = (emailInput?.value || '').trim();
    const password = passwordInput?.value || '';
    const api = window.firebaseApi;
    if (!api?.createUserWithEmailAndPassword || !api?.auth) {
      console.warn('[signup] firebase not available; blocking login');
      setStatus('Firebase authentication is unavailable. Please try again later.', 'error');
      setLoginPending(false);
      return;
    }
    try {
      const cred = await api.createUserWithEmailAndPassword(api.auth, email, password);
      await hydrateFromAuthUser(cred.user, username);
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
        setLoginPending(false);
        return;
      }
    } catch (err) {
      console.error('[signup] failed', err);
      setLoginPending(false);
      alert(err?.message || 'Sign up failed. Please try again.');
    } finally {
      if (!window?.location?.href.includes('document-dashboard.html')) {
        setLoginPending(false);
      }
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email = (emailInput?.value || '').trim();
    const password = passwordInput?.value || '';
    const api = window.firebaseApi;
    if (!api?.signInWithEmailAndPassword || !api?.auth) {
      setStatus('Firebase authentication is unavailable. Please try again later.', 'error');
      return;
    }
    setLoginPending(true, 'Logging in...');
    console.info('[auth] login attempt', { hasAuth: !!api?.auth, hasUser: !!api?.auth?.currentUser });
    try {
      await api.signInWithEmailAndPassword(api.auth, email, password);
      const user = await waitForAuthUser(api);
      await hydrateFromAuthUser(user, usernameInput.value);
    } catch (err) {
      console.error('[login] failed', err);
      try { await api.signOut?.(api.auth); } catch (signOutErr) { console.warn('[login] cleanup signOut failed', signOutErr); }
      setStatus(err?.message || 'Login failed. Please try again.', 'error');
    } finally {
      setLoginPending(false);
    }
  }

  form.addEventListener('submit', handleLogin);
  signupBtn?.addEventListener('click', handleSignup);
  bootstrapAuthSession();
})();
