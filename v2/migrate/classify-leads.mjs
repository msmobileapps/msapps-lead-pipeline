#!/usr/bin/env node
/**
 * One-shot Gemini reclassification pass over imported leads.
 *
 * Reads each lead doc from Firestore (filtered by ownerEmail), sends the
 * title + description to Vertex AI Gemini 2.5 Flash with strict-JSON output,
 * and writes the structured fields (stage, heat, contact_name, contact_phone,
 * company, summary_he, is_dead, next_action) back to the doc.
 *
 * Idempotent: a lead already classified gets re-classified (just overwrites
 * the same fields). To skip already-classified docs, set ONLY_UNCLASSIFIED=1
 * and the script skips any doc that already has `aiClassified: true`.
 *
 * Cost: ~700 tokens × $0.075/M input + 200 tokens × $0.30/M output ≈ $0.0001
 * per lead. 1700 leads ≈ $0.20 total.
 *
 * Concurrency: parallel batches of 10 to keep wall-clock under 5 min for 1700 docs.
 *
 * Auth: ADC (gcloud auth application-default login with cloud-platform scope).
 *
 * Run:
 *   cd v2/migrate
 *   TARGET_OWNER_EMAIL=michal@msapps.mobi \
 *     DRY_RUN=1 \
 *     node classify-leads.mjs
 *
 *   # Real run
 *   TARGET_OWNER_EMAIL=michal@msapps.mobi node classify-leads.mjs
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import {
  VertexGeminiProvider,
  CLASSIFY_LEAD_SCHEMA,
  buildClassifyLeadPrompt,
} from './lib/gemini-provider.js';

const TARGET_OWNER = process.env.TARGET_OWNER_EMAIL;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'opsagent-prod';
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || PROJECT_ID;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DRY = process.env.DRY_RUN === '1';
const ONLY_UNCLASSIFIED = process.env.ONLY_UNCLASSIFIED === '1';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10); // 0 = no limit

if (!TARGET_OWNER) {
  console.error('✖ TARGET_OWNER_EMAIL is required');
  process.exit(1);
}

console.log('▶ classify-leads (Vertex AI Gemini)');
console.log(`  target owner:    ${TARGET_OWNER}`);
console.log(`  vertex project:  ${VERTEX_PROJECT}`);
console.log(`  vertex location: ${VERTEX_LOCATION}`);
console.log(`  model:           ${MODEL}`);
console.log(`  concurrency:     ${CONCURRENCY}`);
console.log(`  dry run:         ${DRY}`);
console.log(`  only unclassified: ${ONLY_UNCLASSIFIED}`);
if (LIMIT) console.log(`  LIMIT:           ${LIMIT}`);

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

// Vertex AI auth — reuse ADC from gcloud.
const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const vertexConfig = {
  vertexProject: VERTEX_PROJECT,
  vertexLocation: VERTEX_LOCATION,
  async getVertexAccessToken() {
    const client = await googleAuth.getClient();
    const tokenInfo = await client.getAccessToken();
    return tokenInfo.token;
  },
};

// ── Fetch leads ───────────────────────────────────────────────────────────
console.log('  fetching leads...');
let q = db.collection('leads').where('ownerEmail', '==', TARGET_OWNER);
if (LIMIT) q = q.limit(LIMIT);
const snap = await q.get();
const all = snap.docs.map((d) => ({ id: d.id, ref: d.ref, data: d.data() }));
const leads = ONLY_UNCLASSIFIED ? all.filter((l) => !l.data.aiClassified) : all;
console.log(`  ${leads.length} leads to classify (of ${all.length} total)`);

// ── Classifier ────────────────────────────────────────────────────────────
async function classifyOne(lead, attempt = 0) {
  const messages = buildClassifyLeadPrompt({
    name: lead.data.name,
    description: lead.data.rawNotes || '',
    dateISO: lead.data.date?.toDate?.()?.toISOString?.() || '',
  });
  try {
    const r = await VertexGeminiProvider.chat(
      messages,
      {
        model: MODEL,
        temperature: 0.1,
        maxTokens: 1024,
        thinkingBudget: 0, // classification doesn't need reasoning — saves cost + tokens
        json: true,
        responseSchema: CLASSIFY_LEAD_SCHEMA,
      },
      vertexConfig
    );
    let parsed;
    try {
      parsed = JSON.parse(r.content);
    } catch (e) {
      throw new Error(`Could not parse Gemini JSON: ${r.content?.slice(0, 200)}`);
    }
    return { parsed, usage: r.usage };
  } catch (err) {
    // Exponential backoff on 429 / 5xx — Vertex Flash trial quota is ~60 RPM.
    const isRetryable =
      /HTTP 429|HTTP 5\d\d|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(err.message);
    if (isRetryable && attempt < 5) {
      const delay = Math.min(60_000, 2000 * Math.pow(2, attempt)) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
      return classifyOne(lead, attempt + 1);
    }
    throw err;
  }
}

async function applyOne(lead) {
  try {
    const { parsed, usage } = await classifyOne(lead);
    const update = {
      stage: parsed.stage,
      heat: parsed.heat,
      aiClassified: true,
      aiClassifiedAt: FieldValue.serverTimestamp(),
      aiSummaryHe: parsed.summary_he || null,
      aiNextAction: parsed.next_action || null,
      aiContactName: parsed.contact_name || null,
      aiCompany: parsed.company || null,
      aiIsDead: !!parsed.is_dead,
    };
    if (parsed.contact_phone) update.contactPhone = parsed.contact_phone;
    if (parsed.contact_email && !lead.data.contactEmail) {
      update.contactEmail = parsed.contact_email;
    }
    if (parsed.is_dead) update.stage = 'לא רלוונטי';

    if (DRY) {
      return { id: lead.id, name: lead.data.name, parsed, usage, dry: true };
    }
    await lead.ref.update(update);
    return { id: lead.id, name: lead.data.name, parsed, usage };
  } catch (err) {
    return { id: lead.id, name: lead.data.name, error: err.message };
  }
}

// ── Concurrent driver ────────────────────────────────────────────────────
let done = 0;
let totalIn = 0, totalOut = 0;
const stageHist = {};
const heatHist = {};

async function runBatch(batch) {
  const results = await Promise.all(batch.map(applyOne));
  for (const r of results) {
    done++;
    if (r.error) {
      console.log(`  ✖ [${done}] ${r.name?.slice(0, 50) || r.id}  → ${r.error.slice(0, 80)}`);
      continue;
    }
    if (r.usage) {
      totalIn += r.usage.promptTokens || 0;
      totalOut += r.usage.outputTokens || 0;
    }
    stageHist[r.parsed.stage] = (stageHist[r.parsed.stage] || 0) + 1;
    heatHist[r.parsed.heat] = (heatHist[r.parsed.heat] || 0) + 1;
    if (done % 50 === 0 || done <= 5) {
      console.log(
        `  [${done}/${leads.length}] ${(r.name || '').slice(0, 40).padEnd(40)} → ` +
          `${r.parsed.stage}/${r.parsed.heat}` +
          (r.parsed.is_dead ? ' (dead)' : '')
      );
    }
  }
}

const start = Date.now();
for (let i = 0; i < leads.length; i += CONCURRENCY) {
  await runBatch(leads.slice(i, i + CONCURRENCY));
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log('');
console.log(`✓ done in ${elapsed}s — ${done} leads processed`);
console.log(`  tokens in: ${totalIn.toLocaleString()}  out: ${totalOut.toLocaleString()}`);
const costIn = (totalIn / 1e6) * 0.075;
const costOut = (totalOut / 1e6) * 0.30;
console.log(`  est cost: $${(costIn + costOut).toFixed(4)} (input $${costIn.toFixed(4)} + output $${costOut.toFixed(4)})`);
console.log('');
console.log('  stages:');
for (const [k, v] of Object.entries(stageHist).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${v.toString().padStart(4)} ${k}`);
}
console.log('  heat:');
for (const [k, v] of Object.entries(heatHist).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${v.toString().padStart(4)} ${k}`);
}
process.exit(0);
