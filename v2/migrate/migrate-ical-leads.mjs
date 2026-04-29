#!/usr/bin/env node
/**
 * OAuth-free migration: Google Calendar .ics export → Firestore leads.
 *
 * Use when `migrate-calendar-leads.mjs` is blocked by Google's "sensitive scope"
 * policy on the source account. This path needs only Firestore admin
 * permission (cloud-platform scope), which is what the existing gcloud ADC
 * already has — no Calendar API auth involved.
 *
 * How to get the .ics file
 *   1. Open Google Calendar in a browser
 *   2. ⚙️ Settings → "Settings for my calendars" → pick the leads calendar
 *   3. "Integrate calendar" section → click "Export calendar" (or the global
 *      Settings → Import & export → Export — downloads a .zip of .ics files)
 *   4. Unzip — you'll get one .ics per calendar (e.g. msmobileapps@gmail.com.ics)
 *
 * Run
 *   cd v2/migrate
 *   npm install  # one-time, installs node-ical
 *   ICS_PATH=/Users/sapirrubin/Downloads/msmobileapps@gmail.com.ics \
 *     TARGET_OWNER_EMAIL=michal@msapps.mobi \
 *     DRY_RUN=1 \
 *     node migrate-ical-leads.mjs
 *
 *   # If the dry-run looks right:
 *   ICS_PATH=... TARGET_OWNER_EMAIL=michal@msapps.mobi node migrate-ical-leads.mjs
 *
 * Idempotent: existing lead with same `source.eventId` (the iCal UID) gets
 * upserted in place, no duplicates on re-run.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import ical from 'node-ical';
import fs from 'node:fs';
import path from 'node:path';

const ICS_PATH = process.env.ICS_PATH;
const TARGET_OWNER = process.env.TARGET_OWNER_EMAIL;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'opsagent-prod';
const DRY = process.env.DRY_RUN === '1';

if (!ICS_PATH || !fs.existsSync(ICS_PATH)) {
  console.error('✖ ICS_PATH is required and must point to an existing .ics file');
  console.error(`  got: ${ICS_PATH || '(unset)'}`);
  process.exit(1);
}
if (!TARGET_OWNER) {
  console.error('✖ TARGET_OWNER_EMAIL is required');
  process.exit(1);
}

console.log('▶ migrate-ical-leads');
console.log(`  ics file:        ${path.resolve(ICS_PATH)}`);
console.log(`  target owner:    ${TARGET_OWNER}`);
console.log(`  firestore proj:  ${PROJECT_ID}`);
console.log(`  dry run:         ${DRY}`);

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const raw = fs.readFileSync(ICS_PATH, 'utf-8');
const parsed = ical.sync.parseICS(raw);

// node-ical returns a flat object keyed by UID; values are events,
// timezones, etc. Filter to type === 'VEVENT'.
const events = Object.values(parsed).filter((v) => v.type === 'VEVENT');
console.log(`  parsed ${events.length} VEVENT entries`);

// ── Helpers (mirrors migrate-calendar-leads.mjs)
function inferStage(summary) {
  const s = String(summary || '').toLowerCase();
  if (/won|נסגר|הצלחה/.test(s)) return 'נסגר בהצלחה';
  if (/lost|דחיתי|לא רלוונטי/.test(s)) return 'לא רלוונטי';
  if (/proposal|הצעה/.test(s)) return 'נשלחה הצעה';
  if (/negotiation|מו"מ|משא ומתן/.test(s)) return 'במשא ומתן';
  if (/follow.?up|מחכה/.test(s)) return 'מחכה לתשובה';
  return 'ליד חדש';
}
function inferHeat(summary) {
  const s = String(summary || '').toLowerCase();
  if (/hot|חם|🔥/.test(s)) return 'hot';
  if (/upsale|upsell/.test(s)) return 'upsale';
  if (/cold|קר/.test(s)) return 'cold';
  if (/warm|פושר/.test(s)) return 'warm';
  return 'normal';
}
function pickContact(attendees, organizer) {
  // node-ical normalizes attendees to an array (or single object). Filter
  // out the organizer + the calendar owner to find a "guest" email.
  const list = Array.isArray(attendees) ? attendees : attendees ? [attendees] : [];
  for (const a of list) {
    const val = a.val || a; // attendee can be a string or object
    const email = typeof val === 'string' ? val.replace(/^MAILTO:/i, '') : (a.params?.MAILTO || '');
    if (email && (!organizer || !String(organizer.val || '').toLowerCase().includes(email.toLowerCase()))) {
      return { email: email.toLowerCase(), phone: '' };
    }
  }
  return { email: '', phone: '' };
}

// Cutoff — only events from the last N years (default 1y).
const SINCE = new Date();
SINCE.setFullYear(SINCE.getFullYear() - parseInt(process.env.YEARS || '1', 10));

let created = 0, updated = 0, skipped = 0;

for (const evt of events) {
  if (!evt.summary) { skipped++; continue; }
  const start = evt.start ? new Date(evt.start) : null;
  if (!start || start < SINCE) { skipped++; continue; }

  const contact = pickContact(evt.attendee, evt.organizer);
  const summary = String(evt.summary).trim();

  const lead = {
    ownerEmail: TARGET_OWNER,
    name: summary,
    stage: inferStage(summary),
    heat: inferHeat(summary),
    date: Timestamp.fromDate(start),
    contactEmail: contact.email,
    contactPhone: contact.phone,
    rawNotes: String(evt.description || '').replace(/<[^>]+>/g, '').trim(),
    updates: [],
    nextSteps: [],
    attachments: [],
    source: {
      kind: 'ical',
      eventId: evt.uid,
      icsFile: path.basename(ICS_PATH),
      organizer: String(evt.organizer?.val || '').replace(/^MAILTO:/i, '').toLowerCase(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (DRY) {
    console.log(`  [dry] ${lead.date.toDate().toISOString().slice(0,10)}  ${lead.name}  (${lead.stage}, ${lead.heat})`);
    skipped++;
    continue;
  }

  const existing = await db
    .collection('leads')
    .where('source.eventId', '==', evt.uid)
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
