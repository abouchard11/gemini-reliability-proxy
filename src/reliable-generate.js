// The reliability core: run a Gemini `generateContent` call across a model FALLBACK CHAIN
// with per-model backoff-retry, 429-aware routing, a per-attempt timeout, and a chain-wide
// time budget. Framework-agnostic and zero-dependency (uses global fetch only).
//
// Extracted and generalized from a production endpoint that served live model calls at scale;
// the design decisions below are annotated with the incident that caused them.

const GENERATE_CONTENT_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Fail immediately on these — neither a retry nor a fallback model will fix them.
// 429 is deliberately ABSENT: Gemini rate limits are PER-MODEL, so a 429 on the primary should
// fall straight through to the next model (separate quota) instead of burning this model's
// retry/backoff window. 504 (our own timeout) is also absent — timeouts are retried.
export const DEFAULT_NON_RETRYABLE = new Set([400, 401, 403, 404, 413]);

export const DEFAULTS = Object.freeze({
  maxRetries: 2, // attempts per model on a transient failure
  timeoutMs: 9000, // per-attempt upstream timeout
  chainBudgetMs: 18000, // chain-wide wall-clock budget
});

/** Sleep with +/-500ms jitter so a synchronized burst doesn't retry in lockstep. */
function defaultSleep(baseMs) {
  const jitter = (Math.random() - 0.5) * 1000;
  const ms = Math.max(100, baseMs + jitter);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call ONE model with backoff-retry on transient failures.
 *   5xx / network error / timeout -> backoff, then retry this model (up to maxRetries)
 *   429 (rate limit)              -> return immediately, NO same-model retry, so the caller
 *                                    can fall through to the next model with the full remaining
 *                                    budget. A per-minute quota won't clear in a ~1-2s backoff;
 *                                    the next model's separate quota is a far better use of it.
 *   non-retryable (400/401/…)     -> return immediately with nonRetryable:true
 * @returns {Promise<{ok:boolean,status:number,text?:string,usage?:object|null,attempts?:number,detail?:string,nonRetryable?:boolean}>}
 */
async function callModelWithRetry(model, body, apiKey, opts) {
  const { timeoutMs, maxRetries, nonRetryable, fetchImpl, sleep } = opts;
  let lastStatus = 0;
  let lastDetail = '';

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream;
    let okData;
    let errDetail = '';
    try {
      upstream = await fetchImpl(GENERATE_CONTENT_URL(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Read the body INSIDE the abort window (success OR error detail) so a stalled body read
      // is bounded by the same timeout instead of being left to hang.
      if (upstream.ok) {
        okData = await upstream.json();
      } else {
        try {
          errDetail = (await upstream.json())?.error?.message || '';
        } catch {
          /* best-effort error detail */
        }
      }
    } catch (err) {
      clearTimeout(timer);
      // Our own abort (timeout) is retryable (treat as 504); anything else is a network error (502).
      if (err && err.name === 'AbortError') {
        lastStatus = 504;
        lastDetail = 'upstream timeout';
      } else {
        lastStatus = 502;
        lastDetail = 'network error reaching the model';
      }
      if (attempt < maxRetries - 1) {
        await sleep(1000 * 2 ** attempt); // ~1s, ~2s, …
        continue;
      }
      return { ok: false, status: lastStatus, detail: lastDetail };
    }
    clearTimeout(timer);

    if (upstream.ok) {
      const text = okData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return {
        ok: true,
        status: 200,
        text,
        usage: okData?.usageMetadata ?? null,
        attempts: attempt + 1,
      };
    }

    lastStatus = upstream.status;
    lastDetail = errDetail;

    if (nonRetryable.has(upstream.status)) {
      return { ok: false, status: lastStatus, detail: lastDetail, nonRetryable: true };
    }
    if (upstream.status === 429) {
      // Fall through to the next model — no same-model retry, no backoff.
      return { ok: false, status: 429, detail: lastDetail };
    }
    if (attempt < maxRetries - 1) {
      await sleep(1000 * 2 ** attempt);
    }
  }

  return { ok: false, status: lastStatus, detail: lastDetail };
}

/**
 * Run a Gemini `generateContent` request across a fallback chain of models.
 *
 * @param {object} opts
 * @param {string} opts.apiKey                 Gemini API key (server-side only).
 * @param {string[]} opts.models               Fallback chain, primary-first, e.g.
 *                                              `['gemini-3.5-flash', 'gemini-2.5-flash']`.
 * @param {(model: string) => object} opts.buildBody
 *        Builds the request body for a given model. Called once per model attempted, so you can
 *        vary model-family-specific fields (e.g. thinking config) — see `thinking-config.js`.
 * @param {number} [opts.timeoutMs=9000]       Per-attempt upstream timeout.
 * @param {number} [opts.maxRetries=2]         Attempts per model on a transient failure.
 * @param {number} [opts.chainBudgetMs=18000]  Chain-wide wall-clock budget. Once exceeded, no NEW
 *        model attempt starts — this bounds the rare hung-primary double-fault that would otherwise
 *        grind through every model (a latency and denial-of-wallet bound). It never aborts an
 *        in-flight successful response.
 * @param {Set<number>} [opts.nonRetryable]    Statuses that fail fast (default `DEFAULT_NON_RETRYABLE`).
 * @param {(info: object) => void} [opts.onAttempt]  Observability hook, called after each model.
 * @param {typeof fetch} [opts.fetchImpl=fetch]       Injectable fetch (for tests).
 * @param {(ms: number) => Promise<void>} [opts.sleep] Injectable backoff (for tests).
 * @returns {Promise<{ ok: boolean, status: number, text?: string, model?: string,
 *   usage?: object|null, attempts?: number|null, saw429: boolean, detail?: string,
 *   modelsTried?: string[] }>}
 *   On success: `{ ok:true, text, model, usage, attempts, saw429 }`.
 *   On failure: `{ ok:false, status (429=quota | 502=upstream), detail, saw429, modelsTried }`.
 *   `saw429` is true when any model in the chain was rate-limited — use it to distinguish a
 *   "degraded" (a fallback rescued the call) alert from a full "outage".
 */
export async function reliableGenerate(opts) {
  const {
    apiKey,
    models,
    buildBody,
    timeoutMs = DEFAULTS.timeoutMs,
    maxRetries = DEFAULTS.maxRetries,
    chainBudgetMs = DEFAULTS.chainBudgetMs,
    nonRetryable = DEFAULT_NON_RETRYABLE,
    onAttempt,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = opts;

  if (!apiKey) throw new Error('reliableGenerate: apiKey is required');
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('reliableGenerate: models must be a non-empty array');
  }
  if (typeof buildBody !== 'function') {
    throw new Error('reliableGenerate: buildBody must be a function');
  }

  const startedAt = Date.now();
  const modelsTried = [];
  let lastStatus = 0;
  let lastDetail = '';
  let saw429 = false;

  for (const model of models) {
    // Chain-wide budget guard: if a slow/hung earlier model already blew the budget, do NOT
    // start another attempt — let the failure path return so the caller can serve its own
    // fallback. Gates STARTING an attempt only; it never touches an in-flight success.
    if (Date.now() - startedAt > chainBudgetMs) break;
    modelsTried.push(model);

    const result = await callModelWithRetry(model, buildBody(model), apiKey, {
      timeoutMs,
      maxRetries,
      nonRetryable,
      fetchImpl,
      sleep,
    });
    if (onAttempt) {
      try {
        onAttempt({ model, ...result });
      } catch {
        /* observability must never break the call */
      }
    }

    if (result.ok) {
      return {
        ok: true,
        status: 200,
        text: result.text,
        model,
        usage: result.usage ?? null,
        attempts: result.attempts ?? null,
        saw429,
      };
    }

    lastStatus = result.status;
    lastDetail = result.detail || '';
    if (result.status === 429) saw429 = true;
    if (result.nonRetryable) break; // a 400/401/… won't be fixed by another model
  }

  const status = lastStatus === 429 ? 429 : 502;
  return { ok: false, status, detail: lastDetail, saw429, modelsTried };
}
