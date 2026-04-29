/**
 * Vertex AI Gemini provider — paid-tier opt-in, isolated from the Zero-Key default.
 *
 * Implements the same interface as WorkersAIProvider / OllamaProvider in
 * providers.js — `name`, `models`, `supportedTasks`, `isAvailable`, `chat`,
 * plus `embed` for text-embedding-005. Plugged into the cascade only when
 * the caller has explicitly provided Vertex auth (project + token / auth
 * client). Stays OUT of the default cascade so the Zero-Key invariant
 * (CLAUDE.md rule #1) holds: Workers AI + Ollama remain primary, Gemini
 * activates per-task or via OPSAGENT_AI_CLOUD=1.
 *
 * Native features used:
 *   - JSON mode (`responseMimeType: 'application/json'`) — for structured
 *     classification / extraction without prompt-trick parsing.
 *   - JSON schema enforcement (`responseSchema`) — guarantees output shape.
 *   - 1M-token context window on flash, 2M on pro.
 *
 * Auth contract (one of):
 *   config.vertexAccessToken            — pre-fetched OAuth token (string)
 *   config.getVertexAccessToken          — async () => string, called per-request
 *
 * @module opsagent-core/ai/gemini-provider
 */

const VERTEX_API_HOST = 'aiplatform.googleapis.com';

export const VertexGeminiProvider = {
  name: 'vertex-gemini',
  models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  supportedTasks: ['classification', 'extraction', 'chat', 'reasoning', 'embedding'],

  isAvailable(config = {}) {
    if (!config.vertexProject) return false;
    return Boolean(config.vertexAccessToken || config.getVertexAccessToken);
  },

  async chat(messages, opts = {}, config = {}) {
    const model = opts.model || 'gemini-2.5-flash';
    const project = config.vertexProject;
    const location = config.vertexLocation || 'us-central1';
    const token = await resolveToken(config);

    // Convert OpenAI-style messages → Vertex contents[] / systemInstruction.
    const { systemInstruction, contents } = toVertexMessages(messages);

    const generationConfig = {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens || 2048,
    };
    if (opts.responseSchema || opts.json) {
      generationConfig.responseMimeType = 'application/json';
      if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;
    }
    if (opts.thinkingBudget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
    }

    const url = `https://${VERTEX_API_HOST}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig,
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Goog-User-Project': project,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Vertex Gemini HTTP ${r.status}: ${txt.slice(0, 300)}`);
    }
    const data = await r.json();

    const content = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('');

    return {
      content,
      provider: 'vertex-gemini',
      model,
      usage: data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount,
            outputTokens: data.usageMetadata.candidatesTokenCount,
            totalTokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
      raw: opts.includeRaw ? data : undefined,
    };
  },

  /**
   * text-embedding-005 — 768-dim by default, supports up to 3072.
   */
  async embed(text, config = {}) {
    const project = config.vertexProject;
    const location = config.vertexLocation || 'us-central1';
    const model = 'text-embedding-005';
    const token = await resolveToken(config);

    const url = `https://${VERTEX_API_HOST}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Goog-User-Project': project,
      },
      body: JSON.stringify({
        instances: [{ content: text, task_type: 'RETRIEVAL_DOCUMENT' }],
      }),
    });
    if (!r.ok) throw new Error(`Vertex embed HTTP ${r.status}`);
    const data = await r.json();
    return {
      embedding: data.predictions?.[0]?.embeddings?.values || [],
      provider: 'vertex-gemini',
      model,
    };
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function resolveToken(config) {
  if (config.vertexAccessToken) return config.vertexAccessToken;
  if (typeof config.getVertexAccessToken === 'function') {
    return config.getVertexAccessToken();
  }
  throw new Error(
    'Vertex Gemini provider needs config.vertexAccessToken or config.getVertexAccessToken'
  );
}

/**
 * Map OpenAI-style messages [{role: 'user'|'assistant'|'system', content}]
 * to Vertex Gemini's contents[] + systemInstruction shape.
 */
function toVertexMessages(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const m of messages) {
    const role = m.role || 'user';
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (role === 'system') {
      systemInstruction = systemInstruction
        ? { parts: [{ text: systemInstruction.parts[0].text + '\n\n' + text }] }
        : { parts: [{ text }] };
    } else {
      // Vertex uses 'user' and 'model' (not 'assistant').
      contents.push({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      });
    }
  }

  // Vertex requires at least one content message.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  }

  return { systemInstruction, contents };
}

// ── Pre-built classifyLead task contract ──────────────────────────────────
//
// Reusable structured-output classifier for sales leads (Hebrew / English).
// Use case: re-classify the 1,676 leads imported from Google Calendar into
// stage / heat / contact info / next-action.

export const CLASSIFY_LEAD_SCHEMA = {
  type: 'object',
  properties: {
    stage: {
      type: 'string',
      enum: [
        'ליד חדש',
        'פנייה ראשונה',
        'פגישה/שיחה',
        'הצעת מחיר',
        'משא ומתן',
        'ממתין לתשובה',
        'נסגר בהצלחה',
        'לא רלוונטי',
      ],
    },
    heat: {
      type: 'string',
      enum: ['hot', 'upsale', 'warm', 'normal', 'cold'],
    },
    is_dead: { type: 'boolean' },
    next_action: { type: 'string' },
    contact_name: { type: 'string' },
    contact_phone: { type: 'string' },
    contact_email: { type: 'string' },
    company: { type: 'string' },
    summary_he: { type: 'string' },
  },
  required: ['stage', 'heat', 'is_dead', 'summary_he'],
};

export const CLASSIFY_LEAD_SYSTEM = `You classify Hebrew/English sales leads.

Rules:
- "Hot" / "HOT" / "פרטנר" / "סלקום" / "בזק" are company names, NOT heat signals.
- Hebrew "חם" or 🔴 or 🔥 = heat: "hot".
- "המשרה נסגרה" / "לא רלוונטי" / "dead" = is_dead: true, stage: "לא רלוונטי".
- "**סטטוס:**" markers in description override title-based guesses.
- Description with "0" alone on a line = stage: "ליד חדש".
- Default when unsure → stage: "פגישה/שיחה", heat: "normal".
- contact_phone in E.164 (+972...) when present, else empty string.
- summary_he: one short Hebrew sentence about where this lead stands.

Output strict JSON matching the schema. Do not invent fields not present.`;

export function buildClassifyLeadPrompt({ name, description, dateISO }) {
  return [
    { role: 'system', content: CLASSIFY_LEAD_SYSTEM },
    {
      role: 'user',
      content:
        `EVENT TITLE: ${name || '(empty)'}\n` +
        `EVENT DATE: ${dateISO || '(unknown)'}\n` +
        `EVENT DESCRIPTION:\n${(description || '(empty)').slice(0, 8000)}`,
    },
  ];
}
