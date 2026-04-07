/**
 * AI Chat API v2.1 — OpsAgent conversational AI for lead analysis.
 *
 * ⚡ 2026 Model Cascade (ALL free, no credit card needed):
 *
 *   1. Groq — Llama 4 Scout 17B MoE     (fastest TTFT 0.46s, 128K ctx)
 *   2. Cerebras — Qwen3 235B            (largest open-source, 1M tok/day free!)
 *   3. Gemma 4 31B                      (Google open-source, Apache 2.0, Apr 2026!)
 *   4. Gemini 2.5 Pro                   (strongest reasoning, free tier)
 *   5. Gemini 2.5 Flash                 (fast + thinking, free tier)
 *   6. Groq — Llama 3.3 70B            (proven Hebrew quality)
 *   7. HuggingFace — Qwen 2.5 72B      (open-source safety net)
 *
 * Env vars (all free signup, no CC):
 *   GROQ_API_KEY      — https://console.groq.com
 *   CEREBRAS_API_KEY   — https://cloud.cerebras.ai (no CC, no waitlist)
 *   GEMINI_API_KEY     — https://aistudio.google.com
 *   HF_TOKEN           — https://huggingface.co/settings/tokens
 *
 * Frontend sends: { messages: [{role, content}], leadContext: string }
 * Returns:        { response: string, provider: string, latencyMs: number }
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
- להציע אסטרטגיית מעקב וטיימליין

חוקים:
- תמיד ענה בעברית
- היה קצר וקולע — מקסימום 3-4 פסקאות
- השתמש באמוג'י כדי לסמן נקודות חשובות
- אם יש מידע על הליד, השתמש בו בתשובה
- תן המלצות קונקרטיות, לא כלליות
- כשמבקשים טיוטת מייל, כתוב מייל שלם ומקצועי
- כשמבקשים ניתוח סיכונים, היה כנה ומציאותי
- כשמזהה ליד שלא עודכן מעל 30 יום, תתריע ותציע פעולה`


// ── Helpers ────────────────────────────────────────────

function buildMessages(messages, leadContext) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(leadContext ? [{ role: 'system', content: `מידע על הליד:\n${leadContext}` }] : []),
    ...messages,
  ]
}

function getEnv(key) {
  if (typeof globalThis.Netlify !== 'undefined' && globalThis.Netlify.env) {
    return globalThis.Netlify.env.get(key) || ''
  }
  return process.env[key] || ''
}

/**
 * Generic OpenAI-compatible API caller.
 * Works with Groq, Cerebras, HuggingFace, Gemini OpenAI endpoint.
 */
async function callOpenAI({ endpoint, apiKey, model, messages, maxTokens = 2048, temperature = 0.7 }) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[${model}] error: ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (err) {
    console.error(`[${model}] failed:`, err.message)
    return null
  }
}


// ── Provider 1: Groq — Llama 4 Scout 17B MoE ─────────
// Fastest TTFT (0.46s), 128K ctx, multimodal, free (no CC)
async function callGroqScout(messages, leadContext) {
  const apiKey = getEnv('GROQ_API_KEY')
  if (!apiKey) return null
  return callOpenAI({
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey,
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: buildMessages(messages, leadContext),
  })
}


// ── Provider 2: Cerebras — Qwen3 235B ─────────────────
// Largest open-source model available free! 1M tokens/day, no CC, no waitlist.
// 235B parameters, excellent multilingual + reasoning.
async function callCerebrasQwen3(messages, leadContext) {
  const apiKey = getEnv('CEREBRAS_API_KEY')
  if (!apiKey) return null
  return callOpenAI({
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey,
    model: 'qwen-3-235b',
    messages: buildMessages(messages, leadContext),
  })
}


// ── Provider 3: Gemma 4 31B (Google open-source) ──────
// Brand new (Apr 2, 2026), Apache 2.0 license, 31B dense model.
// Available via Google AI Studio with same GEMINI_API_KEY.
async function callGemma4(messages, leadContext) {
  const apiKey = getEnv('GEMINI_API_KEY')
  if (!apiKey) return null

  const systemInstruction = `${SYSTEM_PROMPT}\n\nמידע על הליד:\n${leadContext || 'לא זמין'}`

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
      }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`Gemma4 error: ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null
  } catch (err) {
    console.error('Gemma4 failed:', err.message)
    return null
  }
}


// ── Provider 4: Gemini 2.5 Pro (free tier) ────────────
// Strongest reasoning with built-in thinking, free on Google AI Studio
async function callGeminiPro(messages, leadContext) {
  const apiKey = getEnv('GEMINI_API_KEY')
  if (!apiKey) return null

  const systemInstruction = `${SYSTEM_PROMPT}\n\nמידע על הליד:\n${leadContext || 'לא זמין'}`

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
      }
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`Gemini/Pro error: ${res.status} — ${body.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null
  } catch (err) {
    console.error('Gemini/Pro failed:', err.message)
    return null
  }
}


// ── Provider 4: Gemini 2.5 Flash (free tier) ──────────
// Fast + thinking, OpenAI-compatible endpoint
async function callGeminiFlash(messages, leadContext) {
  const apiKey = getEnv('GEMINI_API_KEY')
  if (!apiKey) return null
  return callOpenAI({
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey,
    model: 'gemini-2.5-flash',
    messages: buildMessages(messages, leadContext),
  })
}


// ── Provider 5: Groq — Llama 3.3 70B ─────────────────
// Proven quality, excellent Hebrew, reliable fallback
async function callGroq70B(messages, leadContext) {
  const apiKey = getEnv('GROQ_API_KEY')
  if (!apiKey) return null
  return callOpenAI({
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey,
    model: 'llama-3.3-70b-versatile',
    messages: buildMessages(messages, leadContext),
  })
}


// ── Provider 6: HuggingFace — Qwen 2.5 72B ───────────// Open-source safety net
async function callHuggingFace(messages, leadContext) {
  const token = getEnv('HF_TOKEN')
  if (!token) return null
  return callOpenAI({
    endpoint: 'https://router.huggingface.co/novita/v3/openai/chat/completions',
    apiKey: token,
    model: 'Qwen/Qwen2.5-72B-Instruct',
    messages: buildMessages(messages, leadContext),
  })
}


// ── Main Handler ──────────────────────────────────────

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

  // 7-provider cascade — all free, no credit card needed
  const providers = [
    { name: 'Groq/Llama-4-Scout',     fn: callGroqScout },
    { name: 'Cerebras/Qwen3-235B',    fn: callCerebrasQwen3 },
    { name: 'Gemma-4-31B',            fn: callGemma4 },
    { name: 'Gemini-2.5-Pro',         fn: callGeminiPro },
    { name: 'Gemini-2.5-Flash',       fn: callGeminiFlash },
    { name: 'Groq/Llama-3.3-70B',     fn: callGroq70B },
    { name: 'HuggingFace/Qwen-72B',   fn: callHuggingFace },
  ]

  for (const provider of providers) {
    const start = Date.now()
    console.log(`[AI] Trying: ${provider.name}`)

    const result = await provider.fn(messages, leadContext)

    if (result) {
      const latencyMs = Date.now() - start
      console.log(`[AI] ✅ ${provider.name} — ${latencyMs}ms`)
      return jsonResponse({
        response: result,        provider: provider.name,
        latencyMs,
      })
    }

    console.log(`[AI] ❌ ${provider.name} — skipped`)
  }

  return jsonResponse(
    {
      error: 'All AI providers failed',
      response: '⚠️ לא הצלחתי להתחבר לשרתי AI כרגע. נסה שוב בעוד כמה שניות.',
      provider: 'none',
    },
    503
  )
}

export const config = { path: '/api/ai-chat' }
