# gemini-reliability-proxy

[![CI](https://github.com/abouchard11/gemini-reliability-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/abouchard11/gemini-reliability-proxy/actions/workflows/ci.yml)

**Treat an unreliable LLM like infrastructure.**

A zero-dependency core for calling Google Gemini from a server, built around the failure modes a
model actually has in production: it rate-limits (429), it 5xx's, it hangs, it truncates its own
output, and every call costs real money. Naive proxies ignore all of that. This one doesn't.

Extracted and generalized from a production endpoint (a live, shipped app) — so the design
decisions below aren't hypothetical. Each one is annotated with the incident that caused it.

- **Zero runtime dependencies** — uses global `fetch`. Node 18+.
- **Framework-agnostic core** — `reliableGenerate()` has no `req`/`res` coupling. Drop it into
  Vercel, Cloudflare, Lambda, or a plain server.
- **Unit-tested** — every module has tests; `fetch` and backoff are injectable, so the retry,
  fallback, timeout, and chain-budget failure paths are all covered.

## Install

```bash
npm i gemini-reliability-proxy
```

Node 18+.

```js
import { reliableGenerate, thinkingConfigFor } from 'gemini-reliability-proxy';

const result = await reliableGenerate({
  apiKey: process.env.GEMINI_API_KEY,
  models: ['gemini-3.5-flash', 'gemini-2.5-flash'], // primary -> transient-error fallback
  buildBody: (model) => ({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 1500,
      thinkingConfig: thinkingConfigFor(model, { level: 'low', budget: 512 }),
    },
  }),
});

if (result.ok) return result.text;         // result.model tells you which model answered
// else: result.status is 429 (quota) or 502 (upstream) — serve your own fallback line
```

A complete serverless endpoint (origin gating + rate limits + cost caps) is in
[`examples/vercel`](examples/vercel).

## What it guarantees

1. **A model fallback chain.** Try the primary; on a transient failure, fall through to the next
   model. `result.model` reports which one actually answered.
2. **429-vs-5xx-aware routing.** A `5xx`/timeout is retried on the *same* model with jittered
   backoff. A `429` is **not** — it returns immediately and falls through to the next model,
   because Gemini quotas are per-model and a per-minute limit won't clear in a 1–2s backoff.
3. **A per-attempt timeout.** One hung upstream fetch can't eat the whole request budget; the
   abort is treated as a retryable `504`.
4. **A chain-wide time budget.** Once total elapsed time crosses `chainBudgetMs`, no *new* model
   attempt starts — bounding the rare hung-primary double-fault. It never aborts an in-flight
   successful response.
5. **Denial-of-wallet limits.** Sliding-window rate limiters (per-IP flood bound + per-user cap)
   and a prompt-length cap keep a hostile client from running up an unbounded bill.

`reliableGenerate` also returns `saw429` — true when *any* model in the chain was rate-limited.
Pair it with `result.ok` to tell a rescued (**degraded**) call from a full **outage**, and pick
the alert severity accordingly.

## Incident-driven design

The interesting decisions here each trace to a specific production failure.

### 1. The output budget that truncated every answer

On Gemini 3.x, **thinking tokens are drawn from the same `maxOutputTokens` budget as the visible
answer.** With the cap at 350, ~330–600 thinking tokens ate almost the whole budget and answers
clipped mid-sentence (`finishReason: MAX_TOKENS`). It looked like the reasoning level
misbehaving; it was a budget-too-small bug. Raising it 350 → 1500 left room for both, and calls
finished at `STOP`. `thinkingConfigFor()` + `outputBudgetFor()` encode the lesson: when reasoning
is on, size the output budget for *reasoning + answer*, not just the answer.

### 2. The 429 that shouldn't be retried

Retrying a rate-limited model wastes the client's budget on the one model that can't answer.
Because Gemini quotas are **per-model**, the fix is to treat `429` as "skip to the next model
immediately" — no same-model retry, no backoff — while still retrying genuine transient `5xx`s.
Only a `429` across *every* model in the chain surfaces as a quota error to the caller.

### 3. The hung primary that ground to a 38-second failure

A slow/hung primary could exhaust its retries *and* fall through to the secondary, stacking two
full timeout budgets into a ~35–38s request that blew every client deadline. The chain-wide
budget (`chainBudgetMs`, default 18s) gates whether to *start* the next model attempt, so a
double-fault fails fast to your fallback line instead of grinding — a latency bound and a
denial-of-wallet bound in one.

## API

| Export | What it does |
|---|---|
| `reliableGenerate(opts)` | The core. Runs the fallback chain with retry/timeout/budget. Returns `{ ok, text, model, status, usage, attempts, saw429 }`. |
| `thinkingConfigFor(model, { level, budget })` | Family-correct `thinkingConfig` (3.x `thinkingLevel` vs 2.5 `thinkingBudget`). |
| `outputBudgetFor(answerTokens, headroom?)` | Sizes `maxOutputTokens` for reasoning + answer. |
| `createSlidingWindowLimiter({ windowMs, max })` | Key-agnostic in-memory limiter. |
| `createIpFloodLimiter({ perMinute, perHour })` | Two-window per-IP flood bound. |
| `createKeyLimiter({ windowMs, max })` | Per-user (bearer-token) cap. |
| `createOriginGate({ hosts, suffixes })` | Configurable origin allowlist + CORS headers. |

Full option docs are in the JSDoc on each function.

### Notes & trade-offs

- **Rate-limit state is in-memory, per warm instance** — it resets on cold start. That's the
  cheap denial-of-wallet layer; for a hard cross-instance guarantee, put a shared store (Redis)
  or the provider's own spend cap behind it.
- **`buildBody` runs once per model** so you can adapt model-family-specific fields (reasoning
  config, output caps) as the chain falls through.

## Test

```bash
npm install
npm test        # vitest — covers the fallback/retry/timeout/budget paths and the limiters
```

## Rights

**Proprietary — all rights reserved. No license is granted.** See [LICENSE](LICENSE).
