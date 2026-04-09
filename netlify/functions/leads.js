/**
 * Leads API — reads and writes leads from Google Calendar.
 * GET: Returns prioritized leads + stats (14 days back, max 50 events)
 * POST: Actions — changeColor, moveDate, updateNotes, closeLead
 */
import { handleCors, jsonResponse } from './_lib/store.js'
import { listEvents, searchEvents, updateEventColor, moveEvent, updateEventDescription, createEvent, deleteEvent } from './_lib/gcal.js'
import { mapEventsToLeads, sortLeads, computeStats, eventToLead } from './_lib/lead-mapper.js'

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url)
      const searchQuery = url.searchParams.get('search') || ''
      const daysBack = parseInt(url.searchParams.get('daysBack') || '14', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)

      let events
      if (searchQuery.trim()) {
        // Full-text search across all time via GCal API q param
        events = await searchEvents(searchQuery.trim(), { maxResults: limit })
      } else {
        events = await listEvents({ daysBack, daysForward: 0, maxResults: limit })
      }

      const leads = sortLeads(mapEventsToLeads(events))
      const stats = computeStats(leads)

      return jsonResponse({
        success: true,
        leads,
        stats,
        total: leads.length,
        searchQuery: searchQuery || null,
        fetchedAt: new Date().toISOString(),
      })
    }

    if (request.method === 'POST') {
      const body = await request.json()
      const { action, eventId } = body
      // Support both flat body params (direct) and nested payload (frontend format).
      // Frontend sends: { action, eventId, payload: { colorId, date, note, ... } }
      // Backend previously expected: { action, eventId, colorId, newDate, description, ... }
      // Fix: read from body.payload first, then fall back to top-level body field.
      const payload = body.payload || {}

      if (!action) {
        return jsonResponse({ error: 'Missing action field' }, 400)
      }

      if (action === 'changeColor') {
        const colorId = payload.colorId ?? body.colorId
        if (!eventId || !colorId) return jsonResponse({ error: 'Missing eventId or colorId' }, 400)
        const updated = await updateEventColor(eventId, colorId)
        return jsonResponse({ success: true, event: updated })
      }

      if (action === 'moveDate') {
        // Frontend sends payload.date; legacy callers may send body.newDate
        const newDate = payload.date ?? payload.newDate ?? body.newDate ?? body.date
        if (!eventId || !newDate) return jsonResponse({ error: 'Missing eventId or newDate' }, 400)
        const updated = await moveEvent(eventId, newDate)
        return jsonResponse({ success: true, event: updated })
      }

      if (action === 'updateNotes') {
        // Frontend sends payload.{ note, status, nextStep }; legacy callers send body.description
        const description = payload.description ?? body.description
        const note = payload.note ?? body.note
        const status = payload.status ?? body.status
        const nextStep = payload.nextStep ?? body.nextStep
        if (!eventId) return jsonResponse({ error: 'Missing eventId' }, 400)
        // Build structured description if note/status/nextStep provided; else use raw description
        let finalDescription = description || ''
        if (note || status || nextStep) {
          const today = new Date().toISOString().split('T')[0]
          const lines = []
          if (status) lines.push(`שלב: ${status}`)
          if (note) lines.push(`עדכון ${today}: ${note}`)
          if (nextStep) lines.push(`צעד הבא: ${nextStep}`)
          finalDescription = lines.join('\n')
        }
        const updated = await updateEventDescription(eventId, finalDescription)
        return jsonResponse({ success: true, event: updated })
      }

      if (action === 'closeLead') {
        // Close = set gray color (8) + update description
        if (!eventId) return jsonResponse({ error: 'Missing eventId' }, 400)
        await updateEventColor(eventId, '8')
        const reason = payload.reason ?? body.reason
        const desc = reason ? `שלב: לא רלוונטי\nעדכון: ${new Date().toISOString().split('T')[0]} — ${reason}` : 'שלב: לא רלוונטי'
        const updated = await updateEventDescription(eventId, desc)
        return jsonResponse({ success: true, event: updated })
      }

      // ── CRUD actions (STD: create, update-status, delete) ──
      if (action === 'create') {
        const name = payload.name ?? body.name
        const company = payload.company ?? body.company
        const date = payload.date ?? body.date
        const colorId = payload.colorId ?? body.colorId
        if (!name) return jsonResponse({ error: 'Missing name for lead creation' }, 400)
        const summary = company ? `${name} — ${company}` : name
        const description = payload.description ?? body.description ?? ''
        const event = await createEvent({ summary, description, date, colorId })
        const lead = eventToLead(event)
        return jsonResponse({ success: true, lead, event })
      }

      if (action === 'update-status') {
        const status = payload.status ?? body.status
        const colorId = payload.colorId ?? body.colorId
        const note = payload.note ?? body.note
        if (!eventId) return jsonResponse({ error: 'Missing eventId' }, 400)
        const results = {}
        // Update color if provided
        if (colorId) {
          results.colorUpdate = await updateEventColor(eventId, colorId)
        }
        // Update description with status/note if provided
        if (status || note) {
          const today = new Date().toISOString().split('T')[0]
          const lines = []
          if (status) lines.push(`שלב: ${status}`)
          if (note) lines.push(`עדכון ${today}: ${note}`)
          const description = lines.join('\n')
          results.descUpdate = await updateEventDescription(eventId, description)
        }
        return jsonResponse({ success: true, ...results })
      }

      if (action === 'delete') {
        if (!eventId) return jsonResponse({ error: 'Missing eventId' }, 400)
        const result = await deleteEvent(eventId)
        return jsonResponse({ success: true, ...result })
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
