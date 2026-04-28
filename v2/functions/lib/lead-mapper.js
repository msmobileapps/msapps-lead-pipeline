/**
 * Stage list and helpers for Firestore-stored leads.
 * Schema (Firestore doc in `leads/{id}`):
 *   {
 *     ownerEmail: string         // partition key, must equal request.auth.token.email
 *     name:       string         // lead name
 *     stage:      string         // one of STAGES
 *     heat:       string         // 'hot' | 'upsale' | 'warm' | 'normal' | 'cold'
 *     date:       Timestamp      // primary sort key (latest first)
 *     contactEmail?: string
 *     contactPhone?: string
 *     updates:    Array<{ at: Timestamp, text: string }>
 *     nextSteps:  string[]
 *     rawNotes:   string
 *     attachments?: Array<{ title, url, mimeType, iconLink }>
 *     legacyGcalId?: string      // populated by migrate/gcal-to-firestore.js
 *     createdAt:  Timestamp
 *     updatedAt:  Timestamp
 *   }
 */
export const STAGES = [
  'ליד חדש',
  'פנייה ראשונה',
  'פגישה/שיחה',
  'הצעת מחיר',
  'משא ומתן',
  'ממתין לתשובה',
  'נסגר בהצלחה',
  'לא רלוונטי',
];

export const HEAT = {
  hot:    { label: '🔴 חם',    color: '#DC2626' },
  upsale: { label: '🟢 אפסייל', color: '#16A34A' },
  warm:   { label: '🟡 חמים',  color: '#EAB308' },
  cold:   { label: '⚪ קר',     color: '#6B7280' },
  normal: { label: '🔵 רגיל',  color: '#3B82F6' },
};

const STALE_DAYS = 7;

/** Convert a Firestore lead doc + id into the API/UI shape. */
export function docToLead(doc) {
  const data = doc.data ? doc.data() : doc;
  const date = data.date?.toDate?.() || (data.date ? new Date(data.date) : new Date());
  const updated = data.updatedAt?.toDate?.() || (data.updatedAt ? new Date(data.updatedAt) : date);
  const heat = HEAT[data.heat] || HEAT.normal;
  const daysSinceUpdate = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));

  return {
    id: doc.id || data.id,
    name: data.name || 'ללא שם',
    stage: data.stage || 'ליד חדש',
    heat: data.heat || 'normal',
    heatLabel: heat.label,
    heatColor: heat.color,
    priority: data.heat || 'normal',
    priorityLabel: heat.label,
    priorityColor: heat.color,
    date: date.toISOString(),
    dateFormatted: date.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }),
    updates: data.updates || [],
    lastUpdate: data.updates?.length ? data.updates[data.updates.length - 1].text : '',
    nextSteps: data.nextSteps || [],
    nextStep: data.nextSteps?.[0] || '',
    rawNotes: data.rawNotes || '',
    notes: data.rawNotes || '',
    contactEmail: data.contactEmail || '',
    contactPhone: data.contactPhone || '',
    attachments: data.attachments || [],
    isStale: daysSinceUpdate > STALE_DAYS,
    stale: daysSinceUpdate > STALE_DAYS,
    daysSinceUpdate,
    legacyGcalId: data.legacyGcalId || null,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: updated.toISOString(),
  };
}

/** Sort leads: hot first, then by date desc. */
export function sortLeads(leads) {
  const order = { hot: 0, upsale: 1, warm: 2, normal: 3, cold: 4 };
  return [...leads].sort((a, b) => {
    const pa = order[a.heat] ?? 3;
    const pb = order[b.heat] ?? 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.date) - new Date(a.date);
  });
}

/** Compute pipeline stats. */
export function computeStats(leads) {
  const pipeline = leads.filter(l => l.heat !== 'upsale');
  const closed = ['נסגר בהצלחה', 'לא רלוונטי'];
  const byStage = {};
  for (const s of STAGES) byStage[s] = pipeline.filter(l => l.stage === s).length;

  return {
    total: pipeline.length,
    totalWithUpsale: leads.length,
    active: pipeline.filter(l => !closed.includes(l.stage)).length,
    hot: pipeline.filter(l => l.heat === 'hot').length,
    stale: pipeline.filter(l => l.isStale && !closed.includes(l.stage)).length,
    totalLeads: pipeline.length,
    totalActive: pipeline.filter(l => !closed.includes(l.stage)).length,
    totalHot: pipeline.filter(l => l.heat === 'hot').length,
    totalStale: pipeline.filter(l => l.isStale && !closed.includes(l.stage)).length,
    byStage,
    stages: STAGES,
  };
}
