/**
 * OpsAgent State API — returns current agent status and latest briefing.
 * GET /api/ops-state
 */
import { handleCors, jsonResponse, getLatestBriefing } from './_lib/store.js'

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }

    const latestBriefing = await getLatestBriefing()

    return jsonResponse({
      success: true,
      agent: {
        status: 'active',
        name: 'OpsAgent',
        version: '1.0',
        lastRun: latestBriefing?.createdAt || null,
      },
      latestBriefing: latestBriefing
        ? {
            id: latestBriefing.id,
            createdAt: latestBriefing.createdAt,
            summary: latestBriefing.summary || latestBriefing.title || null,
          }
        : null,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    console.error('OpsState API error:', err.message)
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

export const config = { path: '/api/ops-state' }
