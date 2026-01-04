import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

const AUTH_LOG_PREFIX = '[auth-boundary]';

const firebaseConfig = {
  apiKey: "AIzaSyA59N6Oqr6keapLIIabGxKmaeZ9dqKsbps",
  authDomain: "wrokit-1a2be.firebaseapp.com",
  projectId: "wrokit-1a2be",
  storageBucket: "wrokit-1a2be.firebasestorage.app",
  messagingSenderId: "718865637286",
  appId: "1:718865637286:web:b85d805207f7001e2cf967",
  measurementId: "G-9ZXQHS5KV7"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

function logAuth(event, detail) {
  const payload = detail && typeof detail === 'object' ? detail : { detail };
  console.info(`${AUTH_LOG_PREFIX} ${event}`, payload);
}

function userMetaRef(firebaseUid) {
  return doc(db, 'Users', firebaseUid, 'meta', 'profile');
}

async function setUserMeta(tx, metaRef, payload, merge = false) {
  if (merge) {
    tx.set(metaRef, payload, { merge: true });
  } else {
    tx.set(metaRef, payload);
  }
}

export async function claimUsername(firebaseUid, username, email) {
  const usernameDisplay = (username || '').trim();
  if (!firebaseUid || !usernameDisplay) return null;
  const usernameLower = usernameDisplay.toLowerCase();
  const emailLower = (email || '').trim().toLowerCase() || null;
  const metaRef = userMetaRef(firebaseUid);
  const usernameRef = doc(db, 'Usernames', usernameLower);
  const now = serverTimestamp();
  const result = await runTransaction(db, async (tx) => {
    const existingUsernameDoc = await tx.get(usernameRef);
    if (existingUsernameDoc.exists()) {
      throw new Error('Username is already taken. Please choose another one.');
    }
    const metaSnap = await tx.get(metaRef);
    const metaPayload = {
      usernameLower,
      usernameDisplay,
      emailLower,
      updatedAt: now,
    };
    if (!metaSnap.exists()) {
      metaPayload.createdAt = now;
      setUserMeta(tx, metaRef, metaPayload, false);
    } else {
      const existingCreated = metaSnap.data()?.createdAt;
      if (existingCreated) {
        metaPayload.createdAt = existingCreated;
      }
      setUserMeta(tx, metaRef, metaPayload, true);
    }
    tx.set(usernameRef, { uid: firebaseUid, usernameDisplay, createdAt: now });
    return { usernameDisplay, usernameLower, emailLower };
  });
  return result;
}

export async function persistUsernameMapping(firebaseUid, username, email) {
  return claimUsername(firebaseUid, username, email);
}

export async function fetchUserMeta(firebaseUid) {
  if (!firebaseUid) return null;
  const ref = userMetaRef(firebaseUid);
  const snapshot = await getDoc(ref);
  return snapshot.exists() ? snapshot.data() : null;
}

export async function fetchUsernameMapping(firebaseUid) {
  const meta = await fetchUserMeta(firebaseUid);
  if (!meta) return null;
  return { username: meta.usernameDisplay || meta.usernameLower || null };
}

export async function waitForAuthUser(options = {}) {
  const { authInstance = auth, requireUser = true, timeoutMs = 10000 } = options || {};
  if (!authInstance || typeof onAuthStateChanged !== 'function') {
    return null;
  }
  if (requireUser && authInstance.currentUser) {
    return authInstance.currentUser;
  }
  if (!requireUser && authInstance.currentUser !== undefined) {
    return authInstance.currentUser;
  }
  return new Promise((resolve) => {
    let timer = null;
    let unsubscribe = () => {};
    const cleanup = (value) => {
      if (timer) clearTimeout(timer);
      try { unsubscribe?.(); } catch (err) { console.warn('[auth] failed to unsubscribe', err); }
      resolve(value ?? null);
    };
    unsubscribe = onAuthStateChanged(authInstance, (user) => {
      if (requireUser && !user) return;
      cleanup(user || null);
    }, (err) => {
      console.warn('[auth] waitForAuthUser listener failed', err);
      cleanup(authInstance.currentUser || null);
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        cleanup(authInstance.currentUser || null);
      }, timeoutMs);
    }
  });
}

function describeAuthState(authInstance = auth) {
  return {
    hasAuth: Boolean(authInstance),
    hasUser: Boolean(authInstance?.currentUser),
    uid: authInstance?.currentUser?.uid || null,
  };
}

export async function confirmAuthUser(options = {}) {
  const { authInstance = auth, timeoutMs = 12000, reason = 'unspecified' } = options || {};
  if (!authInstance) {
    logAuth('unavailable', { reason });
    return null;
  }
  if (authInstance.currentUser?.uid) {
    logAuth('confirmed.cached', { reason, uid: authInstance.currentUser.uid });
    return authInstance.currentUser;
  }
  const user = await waitForAuthUser({ authInstance, requireUser: true, timeoutMs });
  if (user?.uid) {
    logAuth('confirmed.async', { reason, uid: user.uid });
    return user;
  }
  logAuth('blocked', { reason, state: describeAuthState(authInstance) });
  return null;
}

export async function requireAuthUser(options = {}) {
  const user = await confirmAuthUser(options);
  if (!user) {
    const err = new Error('Authentication required');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }
  return user;
}

let authDebugSubscribed = false;
function ensureAuthDebugLogging(authInstance = auth) {
  if (authDebugSubscribed || !authInstance || typeof onAuthStateChanged !== 'function') return;
  authDebugSubscribed = true;
  onAuthStateChanged(authInstance, (user) => {
    logAuth('transition', { uid: user?.uid || null });
  });
}
ensureAuthDebugLogging(auth);

if (typeof window !== 'undefined') {
  window.firebaseApi = {
    app,
    auth,
    db,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    persistUsernameMapping,
    claimUsername,
    fetchUserMeta,
    fetchUsernameMapping,
    doc,
    getDoc,
    setDoc,
    runTransaction,
    serverTimestamp,
    waitForAuthUser,
    confirmAuthUser,
    requireAuthUser,
  };
}
