/**
 * Leads API — reads and writes leads from Google Calendar.
 * GET: Returns prioritized leads + stats (14 days back, max 50 events)
 * POST: Actions — changeColor, moveDate, updateNotes, closeLead
 */
import { handleCors, jsonResponse } from './_lib/store.js'
import { listEvents, updateEventColor, moveEvent, updateEventDescription } from './_lib/gcal.js'
import { mapEventsToLeads, sortLeads, computeStats } from './_lib/lead-mapper.js'

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const events = await listEvents({ daysBack: 14, daysForward: 0, maxResults: 50 })
      const leads = sortLeads(mapEventsToLeads(events))
      const stats = computeStats(leads)

      return jsonResponse({
        success: true,
        leads,
        stats,
        total: leads.length,
        fetchedAt: new Date().toISOString(),
      })
    }

    if (request.method === 'POST') {
      const body = await request.json()
      const { action, eventId } = body

      if (!action) {
        return jsonResponse({ error: 'Missing action field' }, 400)
      }

      if (action === 'changeColor') {
        const { colorId } = body
        if (!eventId || !colorId) return jsonResponse({ error: 'Missing eventId or colorId' }, 400)
        const updated = await updateEventColor(eventId, colorId)
        return jsonResponse({ success: true, event: updated })
      }

      if (action === 'moveDate') {
        const { newDate } = body
        if (!eventId || !newDate) return jsonResponse({ error: 'Missing eventId or newDate' }, 400)
        const updated = await moveEvent(eventId, newDate)
        return jsonResponse({ success: true, event: updated })
      }

      if (action === 'updateNotes') {
        const { description } = body
        if (!eventId) return jsonResponse({ error: 'Missing eventId' }, 400)
        const updated = await updateEventDescription(eventId, description || '')
        return jsonResponse({ success: true, event: updated })
      }

      if (action === 'closeLead') {
        // Close = set gray color (8) + update description
        if (!eventId) return jsonResponse({ error: 'Missing eventId' }, 400)
        await updateEventColor(eventId, '8')
        const desc = body.reason ? `שלב: לא רלוונטי\nעדכון: ${new Date().toISOString().split('T')[0]} — ${body.reason}` : 'שלב: לא רלוונטי'
        const updated = await updateEventDescription(eventId, desc)
        return jsonResponse({ success: true, event: updated })
      }

      return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }

    return jsonResponse({ error: 'Method not allowed' }, 405)
  } catch (err) {
    console.error('Leads API error:', err.message)
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

export const config = { path: '/api/leads' }
