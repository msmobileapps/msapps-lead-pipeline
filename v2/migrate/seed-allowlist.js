#!/usr/bin/env node
/**
 * Seed the `allowlist` Firestore collection so each user can read their own
 * allowlist doc client-side (used by the UI to confirm "yes, you're approved"
 * even before the custom claim has propagated). Custom-claim enforcement still
 * happens via the beforeUserCreated trigger; this collection is informational.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST = ['michal@msapps.mobi', 'bar.kadosh@msapps.mobi', 'michal@opsagents.agency'];

const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || join(__dirname, '..', 'service-account.json');
initializeApp({ credential: cert(JSON.parse(readFileSync(saPath, 'utf-8'))) });
const db = getFirestore();

const main = async () => {
  for (const email of ALLOWLIST) {
    await db.collection('allowlist').doc(email).set({
      email,
      addedAt: Timestamp.now(),
      role: 'user',
    });
    console.log('✓ allowlisted', email);
  }
};

main().catch(err => { console.error(err); process.exit(1); });
