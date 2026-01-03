import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

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

function safeDoc(...segments) {
  const path = segments.join('/');
  console.info('[firestore][safeDoc]', { path });
  if (segments.length % 2 !== 0) {
    throw new Error(`[firestore] Invalid document reference: ${path} (requires even number of segments).`);
  }
  return doc(db, ...segments);
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
  const metaRef = safeDoc('Users', firebaseUid, 'meta', 'profile');
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
  const ref = safeDoc('Users', firebaseUid, 'meta', 'profile');
  const snapshot = await getDoc(ref);
  return snapshot.exists() ? snapshot.data() : null;
}

export async function fetchUsernameMapping(firebaseUid) {
  const meta = await fetchUserMeta(firebaseUid);
  if (!meta) return null;
  return { username: meta.usernameDisplay || meta.usernameLower || null };
}

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
    safeDoc,
    doc,
    getDoc,
    setDoc,
    runTransaction,
    serverTimestamp,
  };
}
