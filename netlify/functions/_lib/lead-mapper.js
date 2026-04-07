/**
 * Maps Google Calendar events to Lead objects.
 * Parses stage, update history, and next-steps from event descriptions.
 *
 * Color mapping (GCal colorId → priority/heat):
 *   11 (Red)    = Hot lead 🔴
 *   10 (Green)  = Upsale opportunity 🟢
 *   5  (Yellow) = Warm lead 🟡
 *   8  (Gray)   = Cold / closed ⚪
 */

const COLOR_MAP = {
  '11': { priority: 'hot', heatLabel: '🔴 חם', heatColor: '#DC2626' },
  '10': { priority: 'upsale', heatLabel: '🟢 אפסייל', heatColor: '#16A34A' },
  '5':  { priority: 'warm', heatLabel: '🟡 חמים', heatColor: '#EAB308' },
  '8':  { priority: 'cold', heatLabel: '⚪ קר', heatColor: '#6B7280' },
}

const DEFAULT_COLOR = { priority: 'normal', heatLabel: '🔵 רגיל', heatColor: '#3B82F6' }

const STAGES = [
  'ליד חדש',
  'פנייה ראשונה',
  'פגישה/שיחה',
  'הצעת מחיר',
  'משא ומתן',
  'ממתין לתשובה',
  'נסגר בהצלחה',
  'לא רלוונטי',
]

const SKIP_EVENTS = ['Social Media', 'מכרזים']

/**
 * Strip HTML tags from description text.
 */
function stripHtml(html) {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

/**
 * Parse the event description for structured fields.
 * Handles both plain text and HTML descriptions from GCal.
 * Expected structured format (inside description):
 *   סטטוס: <stage keyword>
 *   שלב: <stage>
 *   עדכון <date>: <text>
 *   צעד הבא: <text>
 */
function parseDescription(desc) {
  if (!desc) return { stage: null, updates: [], nextSteps: [], lastUpdate: '', rawNotes: '' }

  const plain = stripHtml(desc)
  const lines = plain.split('\n').map(l => l.trim()).filter(Boolean)

  let stage = null
  const nextSteps = []
  const updates = []
  const noteLines = []

  for (const line of lines) {
    const lower = line.toLowerCase()

    // Stage detection from "שלב:" or "סטטוס:" prefixes
    if (line.startsWith('שלב:') || line.startsWith('סטטוס:')) {
      const val = line.replace(/^(שלב|סטטוס):/, '').trim()
      const matched = STAGES.find(s => val.includes(s))
      if (matched) stage = matched
    }
    // Update lines
    else if (line.startsWith('עדכון') && line.includes(':')) {
      updates.push(line.replace(/^עדכון\s*/, '').trim())
    }
    // Next step lines
    else if (line.startsWith('צעד הבא:') || line.startsWith('צעדים:')) {
      const val = line.replace(/^(צעד הבא|צעדים):/, '').trim()
      if (val) nextSteps.push(val)
    }
    else {
      noteLines.push(line)
    }
  }

  // Also try to detect stage from keywords anywhere in the text
  if (!stage) {
    const fullText = plain.toLowerCase()
    if (fullText.includes('נסגר בהצלחה') || fullText.includes('סגור') || fullText.includes('won')) {
      stage = 'נסגר בהצלחה'
    } else if (fullText.includes('לא רלוונטי') || fullText.includes('lost') || fullText.includes('ליד אפור')) {
      stage = 'לא רלוונטי'
    } else if (fullText.includes('הצעת מחיר') || fullText.includes('proposal')) {
      stage = 'הצעת מחיר'
    } else if (fullText.includes('משא ומתן') || fullText.includes('negotiat')) {
      stage = 'משא ומתן'
    } else if (fullText.includes('ממתין לתשובה') || fullText.includes('waiting') || fullText.includes('ממתין')) {
      stage = 'ממתין לתשובה'
    } else if (fullText.includes('פגישה') || fullText.includes('שיחה') || fullText.includes('meeting')) {
      stage = 'פגישה/שיחה'
    } else if (fullText.includes('פנייה ראשונה') || fullText.includes('פנייה') || fullText.includes('first contact')) {
      stage = 'פנייה ראשונה'
    }
  }

  const lastUpdate = updates.length > 0 ? updates[updates.length - 1] : ''
  const rawNotes = noteLines.join('\n').trim()

  return { stage, updates, nextSteps, lastUpdate, rawNotes }
}

/**
 * Compute days since last update.
 */
function computeDaysSinceUpdate(event) {
  const updated = new Date(event.updated || event.created)
  const now = new Date()
  return Math.floor((now - updated) / (1000 * 60 * 60 * 24))
}

/**
 * Format a date in Hebrew locale.
 */
function formatDate(dateStr) {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}

/**
 * Map a single GCal event to a Lead object.
 * Returns the shape the frontend expects.
 */
export function eventToLead(event) {
  const colorId = event.colorId || '0'
  const colorInfo = COLOR_MAP[colorId] || DEFAULT_COLOR
  const parsed = parseDescription(event.description)

  const startDate = event.start?.dateTime || event.start?.date || ''
  const eventDate = startDate ? new Date(startDate) : new Date(event.created)
  const daysSinceUpdate = computeDaysSinceUpdate(event)
  const stale = daysSinceUpdate > 7

  // Determine stage: description parsing > color-based default > 'ליד חדש'
  let stage = parsed.stage
  if (!stage) {
    if (colorId === '8') stage = 'לא רלוונטי'
    else stage = 'ליד חדש'
  }

  return {
    // Core identity
    id: event.id,
    name: event.summary || 'ללא שם',
    colorId,

    // Stage & pipeline
    stage,

    // Heat / priority (frontend uses heatColor + heatLabel)
    priority: colorInfo.priority,
    heatColor: colorInfo.heatColor,
    heatLabel: colorInfo.heatLabel,
    // Also keep priorityLabel/priorityColor for backward compat
    priorityLabel: colorInfo.heatLabel,
    priorityColor: colorInfo.heatColor,

    // Dates
    date: eventDate.toISOString(),
    dateFormatted: formatDate(eventDate),

    // Staleness
    isStale: stale,
    stale, // backward compat
    daysSinceUpdate,

    // Content (must match frontend Dy component expectations)
    updates: parsed.updates,
    lastUpdate: parsed.lastUpdate,
    nextSteps: parsed.nextSteps,  // MUST be array — frontend does .length
    rawNotes: parsed.rawNotes,

    // Legacy compat
    nextStep: parsed.nextSteps.length > 0 ? parsed.nextSteps[0] : '',
    notes: parsed.rawNotes,

    // GCal link
    gcalLink: event.htmlLink || '',
    created: event.created,
    updated: event.updated,
  }
}

/**
 * Filter out skip events and map all to leads.
 */
export function mapEventsToLeads(events) {
  return events
    .filter(e => {
      const name = (e.summary || '').trim()
      return name && !SKIP_EVENTS.some(skip => name.includes(skip))
    })
    .map(eventToLead)
}

/**
 * Sort leads by priority (hot first), then by date (newest first).
 */
export function sortLeads(leads) {
  const priorityOrder = { hot: 0, upsale: 1, warm: 2, normal: 3, cold: 4 }
  return [...leads].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 3
    const pb = priorityOrder[b.priority] ?? 3
    if (pa !== pb) return pa - pb
    return new Date(b.date) - new Date(a.date)
  })
}

/**
 * Compute pipeline stats from leads.
 */
export function computeStats(leads) {
  const total = leads.length
  const active = leads.filter(l => !['נסגר בהצלחה', 'לא רלוונטי'].includes(l.stage)).length
  const hot = leads.filter(l => l.priority === 'hot').length
  const stale = leads.filter(l => l.isStale && !['נסגר בהצלחה', 'לא רלוונטי'].includes(l.stage)).length

  const byStage = {}
  for (const stage of STAGES) {
    byStage[stage] = leads.filter(l => l.stage === stage).length
  }

  return { total, active, hot, stale, totalLeads: total, totalActive: active, totalHot: hot, totalStale: stale, byStage, stages: STAGES }
}
