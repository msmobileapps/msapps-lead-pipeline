/**
 * Briefing API — daily lead pipeline briefing.
 * GET: Returns latest briefing, history, or specific briefing by id
 * POST: Generates a fresh briefing from current GCal data
 */
import { handleCors, jsonResponse, saveBriefing, getLatestBriefing, getBriefingHistory, getBriefingById } from './_lib/store.js'
import { listEvents } from './_lib/gcal.js'
import { mapEventsToLeads, sortLeads, computeStats } from './_lib/lead-mapper.js'

function generateBriefingContent(leads, stats) {
  const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const hotLeads = leads.filter(l => l.priority === 'hot')
  const staleLeads = leads.filter(l => l.stale && !['נסגר בהצלחה', 'לא רלוונטי'].includes(l.stage))
  const upcomingLeads = leads.filter(l => {
    const d = new Date(l.date)
    const now = new Date()
    const diffDays = (d - now) / (1000 * 60 * 60 * 24)
    return diffDays >= 0 && diffDays <= 3
  })

  let content = `📊 סקירה יומית — ${today}\n\n`
  content += `סה"כ לידים: ${stats.total} | פעילים: ${stats.active} | חמים: ${stats.hot} | דורשים טיפול: ${stats.stale}\n\n`

  if (hotLeads.length > 0) {
    content += `🔴 לידים חמים (${hotLeads.length}):\n`
    for (const l of hotLeads.slice(0, 5)) {
      content += `• ${l.name} — ${l.stage}${l.nextStep ? ` → ${l.nextStep}` : ''}\n`
    }
    content += '\n'
  }

  if (upcomingLeads.length > 0) {
    content += `📅 קרובים (3 ימים הקרובים):\n`
    for (const l of upcomingLeads.slice(0, 5)) {
      content += `• ${l.name} — ${new Date(l.date).toLocaleDateString('he-IL')}\n`
    }
    content += '\n'
  }

  if (staleLeads.length > 0) {
    content += `⚠️ דורשים טיפול (${staleLeads.length}):\n`
    for (const l of staleLeads.slice(0, 5)) {
      content += `• ${l.name} — ${l.daysSinceUpdate} ימים ללא עדכון\n`
    }
    content += '\n'
  }

  // Stage distribution
  content += '📈 התפלגות שלבים:\n'
  for (const [stage, count] of Object.entries(stats.byStage || {})) {
    if (count > 0) content += `• ${stage}: ${count}\n`
  }

  return content
}

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  try {
    if (request.method === 'GET') {
      const url = new URL(request.url)
      const mode = url.searchParams.get('mode') || 'latest'
      const id = url.searchParams.get('id')

      if (mode === 'history') {
        const history = await getBriefingHistory()
        return jsonResponse({ success: true, history })
      }

      if (mode === 'by-id' && id) {
        const briefing = await getBriefingById(id)
        if (!briefing) return jsonResponse({ error: 'Briefing not found' }, 404)
        return jsonResponse({ success: true, briefing })
      }

      // Default: latest
      const briefing = await getLatestBriefing()
      return jsonResponse({ success: true, briefing })
    }

    if (request.method === 'POST') {
      // Generate fresh briefing
      const events = await listEvents({ daysBack: 14, daysForward: 30, maxResults: 50 })
      const leads = sortLeads(mapEventsToLeads(events))
      const stats = computeStats(leads)
      const content = generateBriefingContent(leads, stats)

      const briefing = {
        id: `briefing-${Date.now()}`,
        content,
        stats,
        leadCount: leads.length,
        generatedAt: new Date().toISOString(),
        source: 'manual',
      }

      const saved = await saveBriefing(briefing)
      return jsonResponse({ success: true, briefing: saved })
    }

    return jsonResponse({ error: 'Method not allowed' }, 405)
  } catch (err) {
    console.error('Briefing API error:', err.message)
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

export const config = { path: '/api/briefing' }
