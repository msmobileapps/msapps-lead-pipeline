/**
 * Tasks API — returns available OpsAgent task definitions and run state.
 * GET /api/tasks
 */
import { handleCors, jsonResponse, getLatestBriefing } from './_lib/store.js'

const TASK_DEFINITIONS = [
  {
    id: 'daily-briefing',
    name: 'סקירה יומית',
    description: 'Generate a daily briefing summarizing lead pipeline activity',
    schedule: 'daily',
    icon: '📊',
  },
  {
    id: 'lead-sync',
    name: 'סנכרון לידים',
    description: 'Sync leads from Google Calendar and update pipeline',
    schedule: 'on-demand',
    icon: '🔄',
  },
  {
    id: 'ai-chat',
    name: 'שיחת AI',
    description: 'Interactive AI chat for lead analysis and recommendations',
    schedule: 'on-demand',
    icon: '🤖',
  },
]

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }

    const latestBriefing = await getLatestBriefing()

    // Enrich tasks with last-run info where available
    const tasks = TASK_DEFINITIONS.map((task) => {
      const enriched = { ...task, lastRun: null, status: 'idle' }
      if (task.id === 'daily-briefing' && latestBriefing) {
        enriched.lastRun = latestBriefing.createdAt
        enriched.status = 'completed'
      }
      return enriched
    })

    return jsonResponse({
      success: true,
      tasks,
      total: tasks.length,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Tasks API error:', err.message)
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

export const config = { path: '/api/tasks' }
