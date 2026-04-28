#!/usr/bin/env node
/**
 * One-shot migration script — copy leads from Michal's Google Calendar into
 * Firestore as `leads/*` documents.
 *
 * Usage (run on Michal's Mac, NOT in Cloud Run):
 *   1. Get a service-account JSON for opsagent-prod with Firestore Admin role.
 *   2. Save it as ./service-account.json in this folder.
 *   3. Set GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN in .env (the SAME values
 *      that the v1 Netlify site uses for /api/leads to read GCal).
 *   4. Set MIGRATE_OWNER_EMAIL=michal@msapps.mobi (or whichever owner you want).
 *   5. node migrate/gcal-to-firestore.js
 *
 * Idempotent: re-running upserts by `legacyGcalId`.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config
const OWNER_EMAIL = (process.env.MIGRATE_OWNER_EMAIL || 'michal@msapps.mobi').toLowerCase();
const GCAL_DAYS_BACK = parseInt(process.env.GCAL_DAYS_BACK || '180', 10);
const GCAL_MAX = parseInt(process.env.GCAL_MAX || '500', 10);

// ── Firebase Admin
const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || join(__dirname, '..', 'service-account.json');
initializeApp({ credential: cert(JSON.parse(readFileSync(saPath, 'utf-8'))) });
const db = getFirestore();

// ── GCal OAuth (refresh-token flow, identical to v1's _lib/gcal.js)
async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok) throw new Error(`Token refresh failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.access_token;
}

async function listAllEvents(token) {
  const timeMin = new Date(Date.now() - GCAL_DAYS_BACK * 86400000).toISOString();
  const timeMax = new Date().toISOString();
  const all = [];
  let pageToken;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`GCal list failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    all.push(...(data.items || []));
    pageToken = data.nextPageToken;
    if (all.length >= GCAL_MAX) break;
  } while (pageToken);
  return all.slice(0, GCAL_MAX);
}

// ── Mapping (same logic as v1 lead-mapper, condensed for migration)
const COLOR_MAP = {
  '11': 'hot',
  '10': 'upsale',
  '5':  'warm',
  '8':  'cold',
};
const STAGES = ['ליד חדש','פנייה ראשונה','פגישה/שיחה','הצעת מחיר','משא ומתן','ממתין לתשובה','נסגר בהצלחה','לא רלוונטי'];
const SKIP = ['Social Media', 'מכרזים'];

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function detectStage(text) {
  const lower = (text || '').toLowerCase();
  for (const s of STAGES) if (text.includes(s)) return s;
  if (lower.includes('proposal'))   return 'הצעת מחיר';
  if (lower.includes('negotiat'))   return 'משא ומתן';
  if (lower.includes('waiting'))    return 'ממתין לתשובה';
  if (lower.includes('meeting'))    return 'פגישה/שיחה';
  if (lower.includes('won'))        return 'נסגר בהצלחה';
  if (lower.includes('lost'))       return 'לא רלוונטי';
  return null;
}

function eventToLead(event) {
  const heat = COLOR_MAP[event.colorId] || 'normal';
  const desc = stripHtml(event.description || '');
  const stage = detectStage(desc) || (heat === 'cold' ? 'לא רלוונטי' : 'ליד חדש');
  const startDate = event.start?.dateTime || event.start?.date || event.created;
  const date = new Date(startDate);

  return {
    ownerEmail: OWNER_EMAIL,
    name: event.summary || 'ללא שם',
    stage,
    heat,
    date: Timestamp.fromDate(date),
    rawNotes: desc,
    updates: [],
    nextSteps: [],
    contactEmail: (event.attendees || []).find(a => !a.self && a.email && !a.email.includes('calendar.google.com'))?.email || '',
    contactPhone: '',
    attachments: (event.attachments || []).map(a => ({
      title: a.title || a.fileUrl || '', url: a.fileUrl || '',
      mimeType: a.mimeType || '', iconLink: a.iconLink || '',
    })),
    legacyGcalId: event.id,
    createdAt: Timestamp.fromDate(new Date(event.created)),
    updatedAt: Timestamp.fromDate(new Date(event.updated || event.created)),
  };
}

// ── Main
async function main() {
  console.log(`→ Pulling up to ${GCAL_MAX} events from past ${GCAL_DAYS_BACK} days for ${OWNER_EMAIL}...`);
  const token = await getAccessToken();
  const events = await listAllEvents(token);
  console.log(`  fetched ${events.length} events`);

  const leads = events
    .filter(e => {
      const name = (e.summary || '').trim();
      return name && !SKIP.some(s => name.includes(s));
    })
    .map(eventToLead);
  console.log(`  ${leads.length} after filtering`);

  let written = 0;
  for (const lead of leads) {
    const existing = await db.collection('leads')
      .where('ownerEmail', '==', OWNER_EMAIL)
      .where('legacyGcalId', '==', lead.legacyGcalId)
      .limit(1).get();
    if (existing.empty) {
      await db.collection('leads').add(lead);
    } else {
      await existing.docs[0].ref.set(lead, { merge: true });
    }
    written++;
    if (written % 25 === 0) console.log(`  …${written}/${leads.length}`);
  }
  console.log(`✓ done — ${written} leads upserted to Firestore for ${OWNER_EMAIL}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
