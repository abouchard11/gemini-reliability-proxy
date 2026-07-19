// A minimal Vercel serverless endpoint that wires the reliability core into an HTTP proxy.
// Demonstrates: origin gating, per-IP + per-user rate limiting, a prompt-length cap, a model
// fallback chain with family-specific reasoning config, and how to hook degraded/outage alerts.
//
// This is the compact shape a much larger production endpoint reduces to once the reliability
// engine lives in the library.
import {
  reliableGenerate,
  thinkingConfigFor,
  createOriginGate,
  createIpFloodLimiter,
  createKeyLimiter,
} from 'gemini-reliability-proxy';

const gate = createOriginGate({ suffixes: ['.example.com', '.vercel.app'] });
const ipFlood = createIpFloodLimiter(); // 60/min, 600/hour per IP
const perUser = createKeyLimiter(); // 120/hour per bearer token

const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash']; // primary -> transient-error fallback
const MAX_PROMPT = 8000;

const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
const bearer = (req) => {
  const a = req.headers.authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() || null : null;
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    gate.setCorsHeaders(req, res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!gate.originAllowed(req)) return res.status(403).json({ error: 'forbidden' });
  gate.setCorsHeaders(req, res);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'missing_server_key' });

  // Denial-of-wallet, outer to inner: an unconditional per-IP bound FIRST (a forged
  // random-per-request bearer token must not earn unlimited fan-out), then the per-user cap.
  const ip = clientIp(req);
  if (ipFlood(ip)) return res.status(429).json({ error: 'ip_rate_limited' });
  const token = bearer(req);
  if (perUser(token)) return res.status(429).json({ error: 'user_rate_limited' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  const prompt = body.prompt;
  if (typeof prompt !== 'string' || !prompt) return res.status(400).json({ error: 'invalid_prompt' });
  if (prompt.length > MAX_PROMPT) return res.status(413).json({ error: 'prompt_too_long' }); // length cap = denial-of-wallet
  const systemInstruction = typeof body.systemInstruction === 'string' ? body.systemInstruction : null;

  const result = await reliableGenerate({
    apiKey,
    models: MODELS,
    // buildBody runs per model, so the reasoning config adapts to the model family (3.x vs 2.5).
    buildBody: (model) => ({
      contents: [{ parts: [{ text: prompt }] }],
      ...(systemInstruction ? { system_instruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        maxOutputTokens: 1500, // sized for reasoning tokens + the answer (see the truncation incident)
        thinkingConfig: thinkingConfigFor(model, { level: 'low', budget: 512 }),
      },
    }),
  });

  if (result.ok) {
    // result.saw429 === true means a fallback model rescued a rate-limited primary — the caller got
    // a live answer, so fire a low-severity "degraded" alert here (not a full outage page).
    return res.status(200).json({ text: result.text, model: result.model });
  }
  // Chain exhausted. status is 429 (quota/spend cap) or 502 (upstream error); fire your outage alert here.
  return res
    .status(result.status)
    .json({ error: result.status === 429 ? 'quota_exceeded' : 'upstream_error', detail: result.detail });
}
