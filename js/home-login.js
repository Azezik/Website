(() => {
  const form = document.querySelector('form.auth');
  const usernameInput = document.getElementById('username');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const signupBtn = document.getElementById('signup-btn');

  if (!form || !usernameInput) return;

  function setAuthBusy(isBusy, label) {
    const submitBtn = form?.querySelector('button[type="submit"]');
    if (submitBtn && !submitBtn.dataset.label) {
      submitBtn.dataset.label = submitBtn.textContent || 'Log In';
    }
    if (submitBtn) {
      submitBtn.textContent = isBusy ? (label || submitBtn.dataset.label || 'Log In') : (submitBtn.dataset.label || 'Log In');
    }
    const controls = [usernameInput, emailInput, passwordInput, signupBtn, submitBtn].filter(Boolean);
    controls.forEach((el) => { el.disabled = Boolean(isBusy); });
    form.classList.toggle('loading', Boolean(isBusy));
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
    setAuthBusy(true, 'Signing up...');
    try {
      const cred = await api.createUserWithEmailAndPassword(api.auth, email, password);
      try {
        const authUser = await api.waitForAuthUser?.({ requireUser: true }) || cred.user || null;
        if (!authUser?.uid) {
          throw new Error('Could not establish a login session. Please try again.');
        }
        const claimed = await api.claimUsername?.(authUser.uid, username, email);
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
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogin(event) {
    event?.preventDefault?.();
    const email = (emailInput?.value || '').trim();
    const password = passwordInput?.value || '';
    const api = window.firebaseApi;
    if (!api?.signInWithEmailAndPassword || !api?.auth) {
      console.warn('[login] firebase not available; falling back to local login');
      performLogin();
      return;
    }
    setAuthBusy(true, 'Logging in...');
    try {
      const cred = await api.signInWithEmailAndPassword(api.auth, email, password);
      const authUser = await api.waitForAuthUser?.({ requireUser: true }) || cred.user || null;
      if (!authUser?.uid) {
        throw new Error('Login was created but Firebase authentication is not ready yet. Please try again.');
      }
      const meta = await api.fetchUserMeta?.(authUser.uid);
      const resolvedUsername = meta?.usernameDisplay || meta?.usernameLower || (usernameInput.value || '').trim();
      if (!resolvedUsername) {
        throw new Error('No username is linked to this account. Please contact support.');
      }
      performLogin(resolvedUsername);
    } catch (err) {
      console.error('[login] failed', err);
      alert(err?.message || 'Login failed. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  form.addEventListener('submit', handleLogin);
  signupBtn?.addEventListener('click', handleSignup);
  bootstrapAuthSession();
})();
