/**
 * Scheduled briefing — auto-generates daily briefing via Netlify cron.
 * Schedule: 0 5 * * 0-4 (5:00 UTC = 8:00 IST, Sun–Thu)
 * Skips Friday/Saturday.
 */
import { saveBriefing } from './_lib/store.js'
import { listEvents } from './_lib/gcal.js'
import { mapEventsToLeads, sortLeads, computeStats } from './_lib/lead-mapper.js'

export default async () => {
  const now = new Date()
  const day = now.getDay() // 0=Sun ... 6=Sat

  // Skip Friday (5) and Saturday (6)
  if (day === 5 || day === 6) {
    console.log(`Skipping briefing — ${day === 5 ? 'Friday' : 'Saturday'}`)
    return
  }

  try {
    console.log('Generating scheduled daily briefing...')
    const events = await listEvents({ daysBack: 14, daysForward: 30, maxResults: 50 })
    const leads = sortLeads(mapEventsToLeads(events))
    const stats = computeStats(leads)

    const today = now.toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    let content = `📊 סקירה יומית — ${today}\n\n`
    content += `סה"כ לידים: ${stats.total} | פעילים: ${stats.active} | חמים: ${stats.hot} | דורשים טיפול: ${stats.stale}\n\n`

    const hotLeads = leads.filter(l => l.priority === 'hot')
    if (hotLeads.length > 0) {
      content += `🔴 לידים חמים (${hotLeads.length}):\n`
      for (const l of hotLeads.slice(0, 5)) {
        content += `• ${l.name} — ${l.stage}${l.nextStep ? ` → ${l.nextStep}` : ''}\n`
      }
      content += '\n'
    }

    const staleLeads = leads.filter(l => l.stale && !['נסגר בהצלחה', 'לא רלוונטי'].includes(l.stage))
    if (staleLeads.length > 0) {
      content += `⚠️ דורשים טיפול (${staleLeads.length}):\n`
      for (const l of staleLeads.slice(0, 5)) {
        content += `• ${l.name} — ${l.daysSinceUpdate} ימים ללא עדכון\n`
      }
      content += '\n'
    }

    content += '📈 התפלגות שלבים:\n'
    for (const [stage, count] of Object.entries(stats.stageCounts)) {
      if (count > 0) content += `• ${stage}: ${count}\n`
    }

    const briefing = {
      id: `briefing-${Date.now()}`,
      content,
      stats,
      leadCount: leads.length,
      generatedAt: now.toISOString(),
      source: 'scheduled',
    }

    const saved = await saveBriefing(briefing)
    console.log(`Briefing saved: ${saved.id} — ${leads.length} leads`)
  } catch (err) {
    console.error('Scheduled briefing failed:', err.message)
  }
}

export const config = {
  schedule: '0 5 * * 0-4',
}
