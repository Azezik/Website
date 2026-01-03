import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

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

export async function persistUsernameMapping(firebaseUid, username) {
  if (!firebaseUid || !username) return null;
  const ref = doc(db, 'usernames', firebaseUid);
  await setDoc(ref, { username });
  return ref;
}

export async function fetchUsernameMapping(firebaseUid) {
  if (!firebaseUid) return null;
  const ref = doc(db, 'usernames', firebaseUid);
  const snapshot = await getDoc(ref);
  return snapshot.exists() ? snapshot.data() : null;
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
    fetchUsernameMapping,
  };
}
