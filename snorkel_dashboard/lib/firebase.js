/*
 * firebase.js — the dashboard's connection to Firebase.
 *
 * The dashboard no longer talks to the node server over HTTP. Both sides meet
 * at Firebase instead:
 *
 *   Realtime Database  commands the server picks up, and the status it publishes
 *   Firestore          the Tasks collection, read straight from here
 *
 * That is what lets the dashboard run anywhere — a laptop on another network,
 * a phone, Vercel — while the server sits behind NAT making outbound
 * connections only.
 *
 * There is no sign-in: the dashboard opens straight onto the dashboard. That
 * means the security rules have to allow unauthenticated access, so anyone who
 * has the URL of this database can read the tasks and queue a task. Deliberate
 * trade-off — see database.rules.json.
 */

import { initializeApp, getApps } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.databaseURL);

let app = null;

function ensureApp() {
  if (!firebaseConfigured) {
    throw new Error(
      'Firebase is not configured. Copy .env.local.example to .env.local and fill in the ' +
        'NEXT_PUBLIC_FIREBASE_* values from Firebase console → Project settings → Your apps.'
    );
  }
  if (!app) app = getApps().length ? getApps()[0] : initializeApp(config);
  return app;
}

export const rtdb = () => getDatabase(ensureApp());
export const firestore = () => getFirestore(ensureApp());

export const missingConfigKeys = () =>
  Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
