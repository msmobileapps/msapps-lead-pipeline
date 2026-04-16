/**
 * Google Calendar API client — OAuth2 refresh token flow with cached access token.
 * Used by leads.js, briefing.js, briefing-scheduled.js, and health.js.
 */

let cachedToken = null
let tokenExpiry = 0

function getEnv(key) {
  if (typeof globalThis.Netlify !== 'undefined' && globalThis.Netlify.env) {
    return globalThis.Netlify.env.get(key) || ''
  }
  return process.env[key] || ''
}

/**
 * Get a fresh access token using the refresh token.
 */
async function getAccessToken() {
  const now = Date.now()
  if (cachedToken && now < tokenExpiry - 60_000) {
    return cachedToken
  }

  const clientId = getEnv('GOOGLE_CLIENT_ID')
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')
  const refreshToken = getEnv('GOOGLE_REFRESH_TOKEN')

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth credentials (CLIENT_ID, CLIENT_SECRET, or REFRESH_TOKEN)')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Token refresh failed: ${res.status} — ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  cachedToken = data.access_token
  tokenExpiry = now + (data.expires_in || 3600) * 1000
  return cachedToken
}

/**
 * List calendar events within a time range.
 */
export async function listEvents({ daysBack = 14, daysForward = 30, maxResults = 50 } = {}) {
  const token = await getAccessToken()
  const now = new Date()

  const timeMin = new Date(now)
  timeMin.setDate(timeMin.getDate() - daysBack)

  const timeMax = new Date(now)
  timeMax.setDate(timeMax.getDate() + daysForward)

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'updated',
  })
  // Request attachments and attendees
  params.set('fields', 'items(id,summary,description,colorId,start,end,htmlLink,created,updated,attachments,attendees)')

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Calendar API error: ${res.status} — ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  return data.items || []
}

/**
 * Update an event's color.
 */
export async function updateEventColor(eventId, colorId) {
  const token = await getAccessToken()
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ colorId: String(colorId) }),
    }
  )
  if (!res.ok) throw new Error(`Failed to update color: ${res.status}`)
  return res.json()
}

/**
 * Move an event to a new date.
 */
export async function moveEvent(eventId, newDate) {
  const token = await getAccessToken()

  // First get the current event
  const getRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!getRes.ok) throw new Error(`Failed to get event: ${getRes.status}`)
  const event = await getRes.json()

  // Update with new date
  const start = event.start?.dateTime
    ? { dateTime: new Date(newDate).toISOString(), timeZone: 'Asia/Jerusalem' }
    : { date: newDate.split('T')[0] }
  const end = start

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ start, end }),
    }
  )
  if (!res.ok) throw new Error(`Failed to move event: ${res.status}`)
  return res.json()
}

/**
 * Update event description (for notes).
 */
export async function updateEventDescription(eventId, description) {
  const token = await getAccessToken()
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ description }),
    }
  )
  if (!res.ok) throw new Error(`Failed to update description: ${res.status}`)
  return res.json()
}

/**
 * Create a new calendar event (lead).
 */
export async function createEvent({ summary, description, date, colorId }) {
  const token = await getAccessToken()
  const startDate = date || new Date().toISOString().split('T')[0]
  // Use timed event (1-hour at 09:00 Israel time) — not all-day
  const startDT = `${startDate.split('T')[0]}T09:00:00`
  const endDT = `${startDate.split('T')[0]}T10:00:00`
  const body = {
    summary,
    description: description || '',
    start: { dateTime: startDT, timeZone: 'Asia/Jerusalem' },
    end: { dateTime: endDT, timeZone: 'Asia/Jerusalem' },
  }
  if (colorId) body.colorId = String(colorId)

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Failed to create event: ${res.status} — ${errBody.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Delete a calendar event.
 */
export async function deleteEvent(eventId) {
  const token = await getAccessToken()
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }
  )
  if (!res.ok && res.status !== 410) {
    throw new Error(`Failed to delete event: ${res.status}`)
  }
  return { deleted: true, eventId }
}

/**
 * Check if GCal connection is healthy.
 */
export async function checkHealth() {
  const clientId = getEnv('GOOGLE_CLIENT_ID')
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')
  const refreshToken = getEnv('GOOGLE_REFRESH_TOKEN')

  const envOk = !!(clientId && clientSecret && refreshToken)

  if (!envOk) {
    return {
      status: 'degraded',
      gcalConnected: false,
      envVars: { clientId: !!clientId, clientSecret: !!clientSecret, refreshToken: !!refreshToken },
    }
  }

  try {
    const token = await getAccessToken()
    const params = new URLSearchParams({
      maxResults: '1',
      timeMin: new Date().toISOString(),
    })
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )

    return {
      status: res.ok ? 'ok' : 'degraded',
      gcalConnected: res.ok,
      envVars: { clientId: true, clientSecret: true, refreshToken: true },
      eventsFound: res.ok,
    }
  } catch (err) {
    return {
      status: 'degraded',
      gcalConnected: false,
      error: err.message,
      envVars: { clientId: true, clientSecret: true, refreshToken: true },
    }
  }
}

/**
 * Search calendar events by text query across all time (no date restriction).
 * Uses GCal API `q` parameter for full-text search on summary/description.
 */
export async function searchEvents(query, { maxResults = 50 } = {}) {
  const token = await getAccessToken()

  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'updated',
  })
  // Request attachments and attendees
  params.set('fields', 'items(id,summary,description,colorId,start,end,htmlLink,created,updated,attachments,attendees)')

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Calendar search error: ${res.status} — ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  return data.items || []
}
