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

// Stage classification — Michal's convention:
//   * lone '0' in the description = new lead (only ~15 of 1700 events)
//   * description usually contains a **סטטוס:** marker we can map
//   * everything else = active/in-pipeline (default to פגישה/שיחה — they ARE
//     calendar meetings)
function inferStage(summary, description) {
  const desc = String(description || '');
  // Lone "0" anywhere in description = explicit "new lead" tag.
  // Match a `0` not adjacent to other digits (avoids hits inside dates,
  // phone numbers, money like "100"). Word boundaries don't help in Hebrew
  // text, so we use a digit-adjacent lookaround.
  if (/(?<![0-9])0(?![0-9])/.test(desc)) return 'ליד חדש';

  // Try to map an explicit סטטוס marker.
  const m = desc.match(/(?:^|\n|\*\*)\s*(?:סטטוס|status)\s*[:׃]\s*\**\s*([^*\n,]+)/i);
  if (m) {
    const status = m[1].toLowerCase().trim();
    if (/בהצלחה|won|closed.*won/.test(status)) return 'נסגר בהצלחה';
    if (/נסגר|לא רלוונטי|lost|cancelled/.test(status)) return 'לא רלוונטי';
    if (/הצעת מחיר|proposal|quoted/.test(status)) return 'הצעת מחיר';
    if (/מו["'״׳]?מ|משא ומתן|negotiat/.test(status)) return 'משא ומתן';
    if (/ממתין|מחכה|waiting|pending/.test(status)) return 'ממתין לתשובה';
    if (/פגישה|שיחה|meeting|call/.test(status)) return 'פגישה/שיחה';
    if (/פנייה|reach\s?out|first/.test(status)) return 'פנייה ראשונה';
    if (/ליד חדש|new lead/.test(status)) return 'ליד חדש';
    // Fall through if status text didn't match any known pattern.
  }

  // Title-based (rare — Michal's titles are usually just names).
  const t = String(summary || '').toLowerCase();
  if (/won|נסגר בהצלחה/.test(t)) return 'נסגר בהצלחה';
  if (/lost|דחיתי|לא רלוונטי/.test(t)) return 'לא רלוונטי';
  if (/proposal|הצעת מחיר/.test(t)) return 'הצעת מחיר';
  if (/negotiation|מו["'״׳]?מ|משא ומתן/.test(t)) return 'משא ומתן';
  if (/follow.?up|מחכה|ממתין/.test(t)) return 'ממתין לתשובה';

  // Default: active calendar meeting in the pipeline, stage unknown.
  return 'פגישה/שיחה';
}

// Heat classification — emoji and Hebrew first; English 'hot' is OUT because
// "Hot" is a major Israeli telecom company name and produced false positives.
function inferHeat(summary, description) {
  const blob = (String(summary || '') + ' ' + String(description || '')).toLowerCase();
  if (/🔴|🔥|חם(?![א-ת])/.test(blob)) return 'hot';
  if (/🟢|upsale|upsell|אפסייל/.test(blob)) return 'upsale';
  if (/⚪|🩶|cold|קר(?![א-ת])/.test(blob)) return 'cold';
  if (/🟡|פושר|warm/.test(blob)) return 'warm';
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
  const description = String(evt.description || '');

  const lead = {
    ownerEmail: TARGET_OWNER,
    name: summary,
    stage: inferStage(summary, description),
    heat: inferHeat(summary, description),
    date: Timestamp.fromDate(start),
    contactEmail: contact.email,
    contactPhone: contact.phone,
    rawNotes: description.replace(/<[^>]+>/g, '').trim(),
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
