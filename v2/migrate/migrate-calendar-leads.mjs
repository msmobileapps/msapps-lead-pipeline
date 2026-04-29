#!/usr/bin/env node
/**
 * One-shot migration: Google Calendar events → Firestore leads.
 *
 * Reads events from a source Gmail account's calendar and writes each as a
 * lead document in Firestore, with `ownerEmail` set to the target owner.
 * Idempotent: if a lead already exists with the same `source.eventId`, it's
 * updated in place (no duplicates).
 *
 * Auth (one-time setup on the Mac that runs this):
 *   gcloud auth application-default login \
 *       --client-id-file=<n/a> \
 *       --scopes=email,openid,\
 *https://www.googleapis.com/auth/calendar.readonly,\
 *https://www.googleapis.com/auth/cloud-platform
 *
 * Run:
 *   cd v2
 *   npm install --prefix migrate           # one-time
 *   SOURCE_CAL_ID=primary \
 *   TARGET_OWNER_EMAIL=michal@msapps.mobi \
 *   GCLOUD_USER=msmobileapps@gmail.com \
 *   node migrate/migrate-calendar-leads.mjs
 *
 * Required env vars:
 *   TARGET_OWNER_EMAIL  — ownerEmail to set on each lead in Firestore
 *   SOURCE_CAL_ID       — calendar id to read (default 'primary')
 *   GCLOUD_USER         — Google account whose calendar is being read
 *                         (must match the gcloud auth list active user)
 *   FIREBASE_PROJECT_ID — defaults to opsagent-prod
 *   DRY_RUN             — '1' to log what would be written without writing
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

const TARGET_OWNER = process.env.TARGET_OWNER_EMAIL;
const SOURCE_CAL = process.env.SOURCE_CAL_ID || 'primary';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'opsagent-prod';
const DRY = process.env.DRY_RUN === '1';

if (!TARGET_OWNER) {
  console.error('✖ TARGET_OWNER_EMAIL is required');
  process.exit(1);
}

console.log(`▶ migrate-calendar-leads`);
console.log(`  source calendar: ${SOURCE_CAL}`);
console.log(`  target owner:    ${TARGET_OWNER}`);
console.log(`  firestore proj:  ${PROJECT_ID}`);
console.log(`  dry run:         ${DRY}`);

// ── Firebase Admin (Firestore writes) ─────────────────────────────────────
initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

// ── Google Calendar API ───────────────────────────────────────────────────
const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/cloud-platform',
  ],
});
const calendar = google.calendar({ version: 'v3', auth: await auth.getClient() });

// ── Fetch all events ──────────────────────────────────────────────────────
const events = [];
let pageToken;
const TIME_MIN = process.env.TIME_MIN || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
do {
  const r = await calendar.events.list({
    calendarId: SOURCE_CAL,
    maxResults: 250,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: TIME_MIN,
    pageToken,
  });
  events.push(...(r.data.items || []));
  pageToken = r.data.nextPageToken;
} while (pageToken);

console.log(`  fetched ${events.length} events since ${TIME_MIN}`);

// ── Map event → lead ──────────────────────────────────────────────────────
function inferStage(evt) {
  const summary = (evt.summary || '').toLowerCase();
  if (/won|נסגר|הצלחה/.test(summary)) return 'נסגר בהצלחה';
  if (/lost|דחיתי|לא רלוונטי/.test(summary)) return 'לא רלוונטי';
  if (/proposal|הצעה/.test(summary)) return 'נשלחה הצעה';
  if (/negotiation|מו"מ|משא ומתן/.test(summary)) return 'במשא ומתן';
  if (/follow.?up|מחכה/.test(summary)) return 'מחכה לתשובה';
  return 'ליד חדש';
}
function inferHeat(evt) {
  const summary = (evt.summary || '').toLowerCase();
  if (/hot|חם|🔥/.test(summary)) return 'hot';
  if (/upsale|upsell/.test(summary)) return 'upsale';
  if (/cold|קר/.test(summary)) return 'cold';
  if (/warm|פושר/.test(summary)) return 'warm';
  return 'normal';
}
function pickContact(attendees, organizer) {
  if (!attendees) return { email: '', phone: '' };
  // Prefer first non-self, non-organizer attendee.
  const guest = attendees.find((a) => !a.self && !a.organizer);
  if (guest) return { email: guest.email || '', phone: '' };
  if (organizer && !organizer.self) return { email: organizer.email || '', phone: '' };
  return { email: '', phone: '' };
}

let created = 0, updated = 0, skipped = 0;

for (const evt of events) {
  if (!evt.summary) { skipped++; continue; }
  if (evt.status === 'cancelled') { skipped++; continue; }

  const startDate = evt.start?.dateTime
    ? new Date(evt.start.dateTime)
    : evt.start?.date ? new Date(evt.start.date) : new Date();
  const contact = pickContact(evt.attendees, evt.organizer);

  const lead = {
    ownerEmail: TARGET_OWNER,
    name: evt.summary.trim(),
    stage: inferStage(evt),
    heat: inferHeat(evt),
    date: Timestamp.fromDate(startDate),
    contactEmail: contact.email,
    contactPhone: contact.phone,
    rawNotes: (evt.description || '').replace(/<[^>]+>/g, '').trim(),
    updates: [],
    nextSteps: [],
    attachments: (evt.attachments || []).map((a) => ({
      url: a.fileUrl, name: a.title || '', mimeType: a.mimeType || '',
    })),
    source: {
      kind: 'gcal',
      eventId: evt.id,
      calendar: SOURCE_CAL,
      htmlLink: evt.htmlLink || '',
      organizer: evt.organizer?.email || '',
    },
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (DRY) {
    console.log(`  [dry] ${lead.name}  (${lead.stage}, ${lead.heat})`);
    skipped++;
    continue;
  }

  // Idempotent upsert by source.eventId
  const existing = await db
    .collection('leads')
    .where('source.eventId', '==', evt.id)
    .where('ownerEmail', '==', TARGET_OWNER)
    .limit(1)
    .get();

  if (existing.empty) {
    lead.createdAt = FieldValue.serverTimestamp();
    await db.collection('leads').add(lead);
    created++;
  } else {
    await db.collection('leads').doc(existing.docs[0].id).update(lead);
    updated++;
  }
}

console.log(`✓ done: ${created} created, ${updated} updated, ${skipped} skipped`);
process.exit(0);
