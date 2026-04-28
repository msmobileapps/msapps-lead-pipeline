/**
 * MSApps Lead Pipeline v2 — Cloud Functions for Firebase.
 *
 * Endpoints (all behind Firebase Hosting rewrites at /api/*):
 *   GET  /api/health    — health probe (no auth)
 *   GET  /api/leads     — list current user's leads + stats
 *   POST /api/leads     — create / update / close a lead
 *   GET  /api/briefing  — read latest briefing
 *   POST /api/briefing  — generate fresh briefing (calls Gemma)
 *   POST /api/ai-chat   — AI chat for lead discussions
 *
 * Auth triggers:
 *   onUserCreate — enforces the email allowlist by setting custom claims
 *                  on first sign-in. Non-allowlisted users have their
 *                  Firebase account disabled immediately.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { beforeUserCreated } from 'firebase-functions/v2/identity';
import { logger } from 'firebase-functions';

import { ALLOWLIST, isAllowlisted } from './lib/allowlist.js';
import { verifyRequest } from './lib/auth.js';
import { docToLead, sortLeads, computeStats, STAGES, HEAT } from './lib/lead-mapper.js';

initializeApp();
const db = getFirestore();

const REGION = 'us-central1';
const RUNTIME_OPTS = { region: REGION, cors: true, memory: '256MiB', timeoutSeconds: 30 };

// ───────────────────────────────────────────────────────────────────────────
// Auth: allowlist gatekeeper
// ───────────────────────────────────────────────────────────────────────────

/**
 * Block sign-up for non-allowlisted emails. Runs synchronously before the
 * user account is created (Firebase Auth blocking function).
 */
export const beforeCreate = beforeUserCreated(
  { region: REGION },
  (event) => {
    const email = event.data?.email?.toLowerCase();
    if (!email || !isAllowlisted(email)) {
      logger.warn('Rejected sign-in for non-allowlisted email', { email });
      throw new Error(`Email ${email || '(none)'} is not on the MSApps Leads allowlist.`);
    }
    // Set the custom claim that Firestore rules check.
    return {
      customClaims: { allowlisted: true },
    };
  }
);

// ───────────────────────────────────────────────────────────────────────────
// /api/health — public probe
// ───────────────────────────────────────────────────────────────────────────

export const health = onRequest(RUNTIME_OPTS, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  let firestoreOk = false;
  try {
    await db.collection('allowlist').limit(1).get();
    firestoreOk = true;
  } catch (err) {
    logger.error('Firestore health probe failed', err);
  }

  res.json({
    status: firestoreOk ? 'ok' : 'degraded',
    service: 'msapps-leads-v2',
    firestoreConnected: firestoreOk,
    allowlistSize: ALLOWLIST.length,
    timestamp: new Date().toISOString(),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// /api/leads — CRUD
// ───────────────────────────────────────────────────────────────────────────

export const leads = onRequest(RUNTIME_OPTS, async (req, res) => {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  const ownerEmail = decoded.email.toLowerCase();

  try {
    if (req.method === 'GET') {
      const search = (req.query.search || '').toString().trim().toLowerCase();
      const snap = await db.collection('leads')
        .where('ownerEmail', '==', ownerEmail)
        .orderBy('date', 'desc')
        .limit(parseInt(req.query.limit || '200', 10))
        .get();

      let allLeads = snap.docs.map(docToLead);
      if (search) {
        allLeads = allLeads.filter(l =>
          l.name.toLowerCase().includes(search) ||
          (l.rawNotes || '').toLowerCase().includes(search) ||
          (l.contactEmail || '').toLowerCase().includes(search)
        );
      }

      const sorted = sortLeads(allLeads);
      const stats = computeStats(sorted);
      return res.json({
        success: true,
        leads: sorted,
        stats,
        total: sorted.length,
        ownerEmail,
        searchQuery: search || null,
        fetchedAt: new Date().toISOString(),
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, leadId } = body;
      const payload = body.payload || {};

      if (action === 'create') {
        const data = {
          ownerEmail,
          name: payload.name || 'ליד חדש',
          stage: STAGES.includes(payload.stage) ? payload.stage : 'ליד חדש',
          heat: HEAT[payload.heat] ? payload.heat : 'normal',
          date: payload.date ? Timestamp.fromDate(new Date(payload.date)) : Timestamp.now(),
          contactEmail: payload.contactEmail || '',
          contactPhone: payload.contactPhone || '',
          rawNotes: payload.notes || '',
          updates: [],
          nextSteps: payload.nextSteps || [],
          attachments: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        const ref = await db.collection('leads').add(data);
        return res.json({ success: true, id: ref.id });
      }

      if (!leadId) return res.status(400).json({ error: 'Missing leadId' });
      const ref = db.collection('leads').doc(leadId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Lead not found' });
      if (snap.data().ownerEmail !== ownerEmail) return res.status(403).json({ error: 'Not yours' });

      if (action === 'changeHeat') {
        await ref.update({ heat: payload.heat || 'normal', updatedAt: FieldValue.serverTimestamp() });
        return res.json({ success: true });
      }
      if (action === 'moveDate') {
        await ref.update({ date: Timestamp.fromDate(new Date(payload.date)), updatedAt: FieldValue.serverTimestamp() });
        return res.json({ success: true });
      }
      if (action === 'updateNotes') {
        const update = { updatedAt: FieldValue.serverTimestamp() };
        if (payload.note) {
          update.updates = FieldValue.arrayUnion({
            at: Timestamp.now(),
            text: payload.note,
          });
        }
        if (payload.stage && STAGES.includes(payload.stage)) update.stage = payload.stage;
        if (payload.nextStep) update.nextSteps = FieldValue.arrayUnion(payload.nextStep);
        if (payload.rawNotes !== undefined) update.rawNotes = payload.rawNotes;
        await ref.update(update);
        return res.json({ success: true });
      }
      if (action === 'closeLead') {
        await ref.update({
          stage: payload.stage === 'won' ? 'נסגר בהצלחה' : 'לא רלוונטי',
          heat: 'cold',
          updatedAt: FieldValue.serverTimestamp(),
        });
        return res.json({ success: true });
      }
      if (action === 'delete') {
        await ref.delete();
        return res.json({ success: true });
      }

      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    logger.error('leads handler', err);
    return res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// /api/briefing — daily AI summary
// ───────────────────────────────────────────────────────────────────────────

export const briefing = onRequest(RUNTIME_OPTS, async (req, res) => {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const ownerEmail = decoded.email.toLowerCase();

  try {
    if (req.method === 'GET') {
      const snap = await db.collection('briefings')
        .where('ownerEmail', '==', ownerEmail)
        .orderBy('createdAt', 'desc')
        .limit(30)
        .get();
      const items = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() }));
      return res.json({ success: true, latest: items[0] || null, history: items });
    }
    if (req.method === 'POST') {
      // Pull current leads, build prompt, call Gemma — kept simple here so
      // Michal can extend with the same provider-cascade pattern as v1.
      const leadsSnap = await db.collection('leads')
        .where('ownerEmail', '==', ownerEmail)
        .orderBy('date', 'desc').limit(50).get();
      const leadsArr = sortLeads(leadsSnap.docs.map(docToLead));
      const stats = computeStats(leadsArr);
      const summary = buildBriefingSummary(leadsArr, stats);
      const ref = await db.collection('briefings').add({
        ownerEmail,
        summary,
        stats,
        leadCount: leadsArr.length,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.json({ success: true, id: ref.id, summary, stats });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    logger.error('briefing handler', err);
    return res.status(500).json({ error: err.message });
  }
});

function buildBriefingSummary(leadsArr, stats) {
  const today = new Date().toLocaleDateString('he-IL');
  const lines = [
    `סקירה יומית — ${today}`,
    `סך הכל לידים: ${stats.total} (${stats.active} פעילים, ${stats.hot} חמים, ${stats.stale} ישנים)`,
    '',
    'מה לעשות היום:',
  ];
  const top = leadsArr.filter(l => l.heat === 'hot' || l.isStale).slice(0, 5);
  for (const l of top) {
    lines.push(`• ${l.name} — ${l.stage} (${l.heatLabel})${l.isStale ? ' ⚠️ לא עודכן 7+ ימים' : ''}`);
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// /api/ai-chat — placeholder using Gemma local first (zero-key default)
// ───────────────────────────────────────────────────────────────────────────

export const aiChat = onRequest({ ...RUNTIME_OPTS, timeoutSeconds: 60 }, async (req, res) => {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { messages = [], leadId } = req.body || {};
  const gemmaUrl = process.env.GEMMA_LOCAL_URL;
  const model = process.env.GEMMA_MODEL || 'gemma3:12b';

  if (!gemmaUrl) {
    return res.status(503).json({ error: 'GEMMA_LOCAL_URL not configured' });
  }

  try {
    const r = await fetch(`${gemmaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: 'Upstream error', detail: txt });
    }
    const data = await r.json();
    return res.json({ success: true, leadId, response: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Scheduled briefing — runs every weekday at 8am Israel time.
// ───────────────────────────────────────────────────────────────────────────

export const scheduledBriefing = onSchedule(
  { schedule: '0 8 * * 0-4', timeZone: 'Asia/Jerusalem', region: REGION },
  async () => {
    for (const ownerEmail of ALLOWLIST) {
      try {
        const leadsSnap = await db.collection('leads')
          .where('ownerEmail', '==', ownerEmail)
          .orderBy('date', 'desc').limit(50).get();
        const leadsArr = sortLeads(leadsSnap.docs.map(docToLead));
        const stats = computeStats(leadsArr);
        await db.collection('briefings').add({
          ownerEmail,
          summary: buildBriefingSummary(leadsArr, stats),
          stats,
          leadCount: leadsArr.length,
          scheduled: true,
          createdAt: FieldValue.serverTimestamp(),
        });
        logger.info(`Briefing generated for ${ownerEmail}`);
      } catch (err) {
        logger.error(`Briefing failed for ${ownerEmail}`, err);
      }
    }
  }
);
