import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getAuth, Auth } from "firebase/auth";
import { getFirestore, Firestore } from "firebase/firestore";

/**
 * IMPORTANTISSIMO:
 * - Next.js può eseguire codice anche lato server durante build/prerender.
 * - Firebase Auth (browser) non deve inizializzarsi sul server.
 * - Qui inizializziamo l'app in modo sicuro e creiamo auth/db SOLO in client.
 */

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
};

function assertClientEnv() {
  // Se manca apiKey in produzione, meglio fallire con messaggio chiaro (solo client).
  if (!firebaseConfig.apiKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_FIREBASE_API_KEY. Controlla le Environment Variables su Vercel."
    );
  }
}

function getFirebaseApp(): FirebaseApp {
  if (getApps().length) return getApp();
  return initializeApp(firebaseConfig);
}

export const app = getFirebaseApp();

// ⚠️ auth e db SOLO nel browser
export const auth: Auth = (() => {
  if (typeof window === "undefined") {
    // placeholder: non usare auth lato server
    return {} as Auth;
  }
  assertClientEnv();
  return getAuth(app);
})();

export const db: Firestore = (() => {
  if (typeof window === "undefined") {
    // placeholder: non usare db lato server
    return {} as Firestore;
  }
  assertClientEnv();
  return getFirestore(app);
})();
