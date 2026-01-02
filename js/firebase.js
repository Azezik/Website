import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

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
