/**
 * AI Chat API — OpsAgent conversational AI for lead analysis.
 *
 * Cascading free-tier provider chain:
 *   1. Groq (llama-3.3-70b — fastest, 14.4K req/day free)
 *   2. Gemini (gemini-2.0-flash — 1M tokens/day free)
 *   3. HuggingFace Qwen 72B (open-source)
 *   4. HuggingFace Mistral 7B (lightweight fallback)
 *
 * Frontend sends: { messages: [{role, content}], leadContext: string }
 * Returns:        { response: string, provider: string }
 */
import { handleCors, jsonResponse } from './_lib/store.js'

const SYSTEM_PROMPT = `אתה OpsAgent — עוזר AI חכם לניהול לידים ומכירות עבור MSApps.
אתה מדבר בעברית, מקצועי, ישיר, ועוזר לסגור עסקאות.

התפקיד שלך:
- לנתח לידים ולהמליץ על צעדים הבאים
- לכתוב טיוטות מיילים מקצועיות בעברית
- להכין נקודות לשיחות מכירה
- לזהות סיכונים ולהמליץ על פתרונות
- לתת ניתוח מעמיק של מצב הליד

חוקים:
- תמיד ענה בעברית
- היה קצר וקולע — מקסימום 3-4 פסקאות
- השתמש באמוג'י כדי לסמן נקודות חשובות
- אם יש מידע על הליד, השתמש בו בתשובה
- תן המלצות קונקרטיות, לא כלליות
- כשמבקשים טיוטת מייל, כתוב מייל שלם ומקצועי
- כשמבקשים ניתוח סיכונים, היה כנה ומציאותי`

// Provider 1: Groq (llama-3.3-70b — free, fastest inference)
async function callGroq(messages, leadContext) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return null

  const groqMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(leadContext ? [{ role: 'system', content: `מידע על הליד:\n${leadContext}` }] : []),
    ...messages,
  ]

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: groqMessages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`Groq error: ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (err) {
    console.error('Groq failed:', err.message)
    return null
  }
}

// Provider 2: Gemini (free 1M tokens/day — OpenAI-compatible endpoint)
async function callGeminiOpenAI(messages, leadContext) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  const geminiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(leadContext ? [{ role: 'system', content: `מידע על הליד:\n${leadContext}` }] : []),
    ...messages,
  ]

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
          messages: geminiMessages,
          max_tokens: 1024,
          temperature: 0.7,
        }),
      }
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`Gemini error: ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (err) {
    console.error('Gemini failed:', err.message)
    return null
  }
}

// Provider 3: HuggingFace (Qwen 72B — top open-source)
async function callHuggingFace(messages, leadContext) {
  const token = process.env.HF_TOKEN
  if (!token) return null

  const hfMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(leadContext ? [{ role: 'system', content: `מידע על הליד:\n${leadContext}` }] : []),
    ...messages,
  ]

  try {
    const res = await fetch(
      'https://router.huggingface.co/novita/v3/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen2.5-72B-Instruct',
          messages: hfMessages,
          max_tokens: 1024,
          temperature: 0.7,
        }),
      }
    )

    if (!res.ok) {
      console.error(`HuggingFace/Qwen error: ${res.status}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (err) {
    console.error('HuggingFace/Qwen failed:', err.message)
    return null
  }
}

// Provider 4: HuggingFace (Mistral 7B — lighter fallback)
async function callHuggingFaceSmall(messages, leadContext) {
  const token = process.env.HF_TOKEN
  if (!token) return null

  const hfMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(leadContext ? [{ role: 'system', content: `מידע על הליד:\n${leadContext}` }] : []),
    ...messages,
  ]

  try {
    const res = await fetch(
      'https://router.huggingface.co/hf-inference/models/mistralai/Mistral-7B-Instruct-v0.3/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mistralai/Mistral-7B-Instruct-v0.3',
          messages: hfMessages,
          max_tokens: 1024,
          temperature: 0.7,
        }),
      }
    )

    if (!res.ok) {
      console.error(`HuggingFace/Mistral error: ${res.status}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (err) {
    console.error('HuggingFace/Mistral failed:', err.message)
    return null
  }
}

// Main handler
export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const { messages, leadContext } = body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Messages array is required' }, 400)
  }

  // Try providers in priority order (free-tier cascade)
  const providers = [
    { name: 'Groq/llama-3.3-70b', fn: callGroq },
    { name: 'Gemini/gemini-2.0-flash', fn: callGeminiOpenAI },
    { name: 'HuggingFace/Qwen-72B', fn: callHuggingFace },
    { name: 'HuggingFace/Mistral-7B', fn: callHuggingFaceSmall },
  ]

  for (const provider of providers) {
    console.log(`Trying provider: ${provider.name}`)
    const result = await provider.fn(messages, leadContext)
    if (result) {
      console.log(`Success with: ${provider.name}`)
      return jsonResponse({ response: result, provider: provider.name })
    }
  }

  return jsonResponse(
    {
      error: 'All AI providers failed',
      response: '⚠️ לא הצלחתי להתחבר לשרתי AI כרגע. נסה שוב בעוד כמה שניות.',
    },
    503
  )
}

export const config = { path: '/api/ai-chat' }
