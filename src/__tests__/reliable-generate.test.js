import { describe, expect, it, vi } from 'vitest';
import { reliableGenerate } from '../reliable-generate.js';

// A scripted fetch stand-in: each call consumes the next spec (the last spec repeats).
//   { status, body }        -> resolves to a Response-like { ok, status, json }
//   { throw: Error|object } -> the fetch itself rejects (network error / abort)
function mockFetch(sequence) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const spec = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (spec.hang) {
      // Never resolve on our own — reject ONLY when the per-attempt timeout aborts the signal.
      // This exercises the real setTimeout -> controller.abort() -> AbortError path.
      return await new Promise((_, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (spec.throw) throw spec.throw;
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => spec.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

const ok = (text = 'hello') => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: 42 } },
});
const err = (status, message = 'boom') => ({ status, body: { error: { message } } });

const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const base = (fetchImpl) => ({
  apiKey: 'test-key',
  models: MODELS,
  buildBody: () => ({ contents: [{ parts: [{ text: 'hi' }] }] }),
  fetchImpl,
  sleep: () => Promise.resolve(), // no real backoff delay in tests
});

describe('reliableGenerate', () => {
  it('returns the primary model result on first success', async () => {
    const f = mockFetch([ok('primary answer')]);
    const r = await reliableGenerate(base(f));
    expect(r.ok).toBe(true);
    expect(r.text).toBe('primary answer');
    expect(r.model).toBe('gemini-3.5-flash');
    expect(r.saw429).toBe(false);
    expect(f.calls).toHaveLength(1); // no wasted calls
  });

  it('429 on the primary falls through to the secondary with NO same-model retry', async () => {
    const f = mockFetch([err(429, 'rate limited'), ok('secondary answer')]);
    const r = await reliableGenerate(base(f));
    expect(r.ok).toBe(true);
    expect(r.model).toBe('gemini-2.5-flash');
    expect(r.saw429).toBe(true);
    expect(f.calls).toHaveLength(2); // primary once (no retry), secondary once
    expect(f.calls[0].url).toContain('gemini-3.5-flash');
    expect(f.calls[1].url).toContain('gemini-2.5-flash');
  });

  it('retries a 5xx on the same model (maxRetries), then falls through', async () => {
    const f = mockFetch([err(503), err(503), ok('rescued')]);
    const r = await reliableGenerate(base(f));
    expect(r.ok).toBe(true);
    expect(r.model).toBe('gemini-2.5-flash');
    // primary attempted twice (maxRetries=2), then secondary once
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0].url).toContain('gemini-3.5-flash');
    expect(f.calls[1].url).toContain('gemini-3.5-flash');
  });

  it('a non-retryable status (400) stops the chain immediately — no fallback model', async () => {
    const f = mockFetch([err(400, 'bad request')]);
    const r = await reliableGenerate(base(f));
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(1); // secondary never tried
    expect(r.status).toBe(502); // non-429 failure surfaces as 502
    expect(r.modelsTried).toEqual(['gemini-3.5-flash']); // reports only the model actually attempted
  });

  it('classifies an abort as a retryable timeout (504) and retries', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const f = mockFetch([{ throw: abort }, { throw: abort }, ok('after timeout')]);
    const r = await reliableGenerate(base(f));
    expect(r.ok).toBe(true);
    expect(r.model).toBe('gemini-2.5-flash');
    expect(f.calls).toHaveLength(3);
  });

  it('returns 429 to the caller when every model is rate-limited', async () => {
    const f = mockFetch([err(429), err(429)]);
    const r = await reliableGenerate(base(f));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.saw429).toBe(true);
    expect(r.modelsTried).toEqual(MODELS);
  });

  it('the chain budget prevents starting any attempt once exceeded', async () => {
    const f = mockFetch([ok()]);
    const r = await reliableGenerate({ ...base(f), chainBudgetMs: -1 });
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0); // no model call started
  });

  it('calls the onAttempt observability hook once per model attempted', async () => {
    const f = mockFetch([err(429), ok('ok')]);
    const onAttempt = vi.fn();
    await reliableGenerate({ ...base(f), onAttempt });
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls[0][0]).toMatchObject({ model: 'gemini-3.5-flash', status: 429 });
    expect(onAttempt.mock.calls[1][0]).toMatchObject({ model: 'gemini-2.5-flash', ok: true });
  });

  it('aborts a hung attempt at the per-attempt timeout, classifies it 504, and retries then falls through', async () => {
    // The primary hangs on both attempts; each is aborted by the real setTimeout(timeoutMs) ->
    // controller.abort() path and classified 504 (retryable). After the retries exhaust, the chain
    // falls through to the secondary, which answers.
    const f = mockFetch([{ hang: true }, { hang: true }, ok('after timeout')]);
    const r = await reliableGenerate({ ...base(f), timeoutMs: 10 });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('gemini-2.5-flash');
    expect(f.calls).toHaveLength(3);
  });

  it('a slow earlier model that blows the chain budget prevents starting a later model', async () => {
    const calls = [];
    const slowFail = (url) =>
      new Promise((resolve) => {
        calls.push(url);
        setTimeout(
          () => resolve({ ok: false, status: 500, json: async () => ({ error: { message: 'slow' } }) }),
          30,
        );
      });
    const r = await reliableGenerate({
      apiKey: 'k',
      models: MODELS,
      buildBody: () => ({ contents: [] }),
      fetchImpl: slowFail,
      sleep: () => Promise.resolve(),
      maxRetries: 1,
      chainBudgetMs: 20, // one 30ms primary attempt already blows this
    });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1); // budget guard skipped the secondary
    expect(calls[0]).toContain('gemini-3.5-flash');
    expect(r.modelsTried).toEqual(['gemini-3.5-flash']);
  });

  it('throws on missing required options', async () => {
    await expect(reliableGenerate({ models: MODELS, buildBody: () => ({}) })).rejects.toThrow(/apiKey/);
    await expect(reliableGenerate({ apiKey: 'k', models: [], buildBody: () => ({}) })).rejects.toThrow(/models/);
    await expect(reliableGenerate({ apiKey: 'k', models: MODELS })).rejects.toThrow(/buildBody/);
  });
});
