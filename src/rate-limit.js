// In-memory sliding-window rate limiter (per warm serverless instance). Key-agnostic: the same
// limiter caps by IP (dotted-quad), by bearer token (UUID/opaque), by email — the key is just a
// Map key. State resets on cold start; for a hard cross-instance guarantee put the provider's own
// spend cap or a shared store (Redis) behind it. This is the cheap in-process denial-of-wallet layer.

const CLEANUP_INTERVAL_MS = 300_000; // purge fully-stale keys at most this often

/**
 * Build a sliding-window limiter with its own private state.
 * @param {{ windowMs: number, max: number }} opts
 * @returns {(key: string) => boolean} true when `key` is OVER the limit for the current window
 *   (reject the request); false otherwise (and the call is counted toward the window).
 */
export function createSlidingWindowLimiter({ windowMs, max }) {
  const hitsByKey = new Map(); // key -> [timestamp, ...]
  let lastCleanup = Date.now();

  return function isLimited(key) {
    const now = Date.now();

    // Periodic cleanup: drop keys whose hits have all aged out, to bound memory.
    if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
      for (const [k, hits] of hitsByKey) {
        const fresh = hits.filter((t) => now - t < windowMs);
        if (fresh.length === 0) hitsByKey.delete(k);
        else hitsByKey.set(k, fresh);
      }
      lastCleanup = now;
    }

    const hits = (hitsByKey.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      hitsByKey.set(key, hits);
      return true;
    }
    hits.push(now);
    hitsByKey.set(key, hits);
    return false;
  };
}

/**
 * A two-window per-IP flood bound (burst + sustained). Short-circuits on the minute window so a
 * brief legit burst doesn't consume the hourly budget and lock out everyone behind one NAT.
 * Falsy IPs are never limited and never throw.
 * @param {{ perMinute?: number, perHour?: number }} [o]
 * @returns {(ip: string|null|undefined) => boolean}
 */
export function createIpFloodLimiter({ perMinute = 60, perHour = 600 } = {}) {
  const minute = createSlidingWindowLimiter({ windowMs: 60_000, max: perMinute });
  const hour = createSlidingWindowLimiter({ windowMs: 3_600_000, max: perHour });
  return (ip) => (ip ? minute(ip) || hour(ip) : false);
}

/**
 * A single-window per-key cap (e.g. per bearer token / per user). Falsy keys are never limited
 * (anonymous requests degrade to the IP bound only) and never throw.
 * @param {{ windowMs?: number, max?: number }} [o]
 * @returns {(key: string|null|undefined) => boolean}
 */
export function createKeyLimiter({ windowMs = 3_600_000, max = 120 } = {}) {
  const limiter = createSlidingWindowLimiter({ windowMs, max });
  return (key) => (key ? limiter(key) : false);
}
