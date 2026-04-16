/**
 * AI Chat endpoint for lead creation/update — conversational lead intake.
 * Uses Groq API (llama) for fast, free AI responses.
 */
import { handleCors, jsonResponse } from './_lib/store.js'

function getEnv(key) {
  if (typeof globalThis.Netlify !== 'undefined' && globalThis.Netlify.env) {
    return globalThis.Netlify.env.get(key) || ''
  }
  return process.env[key] || ''
}

const SYSTEM_PROMPT = `אתה עוזר AI של מערכת ניהול לידים של MSApps. התפקיד שלך: לאסוף מידע על ליד חדש או לעדכן ליד קיים.

## התהליך שלך:
1. שאל את המשתמש על הליד — שם, חברה, סטטוס, פרטי קשר, מה קרה
2. אם המשתמש מצרף שיחות וואטסאפ — נתח אותם והוסף תובנות
3. כשיש מספיק מידע, הצג עדכון מובנה לאישור

## פורמט העדכון המובנה (חייב להופיע בתגובה כשיש מספיק מידע):
---LEAD_UPDATE---
עדכון ליד: [שם הליד]
תאריך: [YYYY-MM-DD]
סטטוס: [פגישה ראשונה / במשא ומתן / הצעת מחיר / חתם / לא רלוונטי]
פרטים: [תקציר של מה שקרה]
המלצות לצעד הבא: [מה כדאי לעשות]
תאריך מעקב הבא מומלץ: [YYYY-MM-DD]
חום: [חם/בינוני/קר/אפסייל]
---END_UPDATE---

אחרי הבלוק, שאל "לאשר ולשמור?"

## כללים:
- דבר בעברית
- תהיה קצר וענייני
- אם המשתמש מדביק שיחת וואטסאפ — נתח את השיחה, זהה נקודות מפתח, וסכם
- אם חסר מידע חיוני (שם הליד), שאל עליו
- כשהמשתמש אומר "אשר" / "כן" / "שמור" — החזר בלוק JSON בלבד:
{"approved":true,"lead":{"name":"...","company":"...","date":"YYYY-MM-DD","colorId":"...","description":"...","followUpDate":"YYYY-MM-DD"}}

colorId mapping: 11=חם, 5=בינוני, 10=אפסייל, 8=קר, 2=ברירת מחדל`

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    const apiKey = getEnv('GROQ_API_KEY')
    if (!apiKey) {
      return jsonResponse({ error: 'AI API key not configured' }, 500)
    }

    const body = await request.json()
    const { messages = [], context = {} } = body

    // Build messages for the LLM
    const llmMessages = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))

    // Add context about existing lead if updating
    let systemPrompt = SYSTEM_PROMPT
    if (context.existingLead) {
      systemPrompt += `\n\n## ליד קיים (עדכון):\nשם: ${context.existingLead.name}\nחברה: ${context.existingLead.company || ''}\nסטטוס: ${context.existingLead.stage || ''}\nהערות: ${context.existingLead.rawNotes || ''}`
    }

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          ...llmMessages,
        ],
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`AI API error: ${res.status} — ${errBody.slice(0, 300)}`)
    }

    const data = await res.json()
    const reply = data.choices?.[0]?.message?.content || ''

    // Check if the reply contains an approval JSON
    let approved = false
    let leadData = null
    try {
      const jsonMatch = reply.match(/\{[\s\S]*"approved"\s*:\s*true[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.approved && parsed.lead) {
          approved = true
          leadData = parsed.lead
        }
      }
    } catch {
      // Not JSON — regular chat message
    }

    return jsonResponse({
      success: true,
      response: reply,
      approved,
      leadData,
    })
  } catch (err) {
    console.error('AI Chat error:', err.message)
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

export const config = { path: '/api/ai-chat' }
