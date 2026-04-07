/**
 * Netlify Blobs storage for briefings + CORS utilities.
 * Re-exports handleCors and jsonResponse for all functions.
 * NOTE: @netlify/blobs is imported lazily so functions that only need CORS don't fail.
 */

async function getBlobStore(name) {
  const { getStore } = await import('@netlify/blobs')
  return getStore({ name, consistency: 'strong' })
}

// ── CORS ──────────────────────────────────────────────
function buildHeaders(allowedOrigin = '*') {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  }
}

export function handleCors(request) {
  const method = request.method?.toUpperCase?.() || request.method
  if (method !== 'OPTIONS') return null
  return new Response(null, { status: 204, headers: buildHeaders() })
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...buildHeaders() },
  })
}

// ── Briefing Storage (Netlify Blobs) ──────────────────
const STORE_NAME = 'lead-pipeline'
const BRIEFING_KEY = 'latest-briefing'
const HISTORY_KEY = 'briefing-history'
const MAX_HISTORY = 30

export async function saveBriefing(briefing) {
  const store = await getBlobStore(STORE_NAME)
  const payload = { ...briefing, createdAt: new Date().toISOString() }

  // Save as latest
  await store.setJSON(BRIEFING_KEY, payload)

  // Append to history
  let history = []
  try {
    history = (await store.get(HISTORY_KEY, { type: 'json' })) || []
  } catch { /* empty */ }

  history.unshift(payload)
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY)
  await store.setJSON(HISTORY_KEY, history)

  return payload
}

export async function getLatestBriefing() {
  const store = await getBlobStore(STORE_NAME)
  try {
    return await store.get(BRIEFING_KEY, { type: 'json' })
  } catch {
    return null
  }
}

export async function getBriefingHistory() {
  const store = await getBlobStore(STORE_NAME)
  try {
    return (await store.get(HISTORY_KEY, { type: 'json' })) || []
  } catch {
    return []
  }
}

export async function getBriefingById(id) {
  const history = await getBriefingHistory()
  return history.find(b => b.id === id) || null
}
