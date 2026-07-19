import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlidingWindowLimiter, createIpFloodLimiter, createKeyLimiter } from '../rate-limit.js';

describe('createSlidingWindowLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('accumulates distinct keys independently', () => {
    const limited = createSlidingWindowLimiter({ windowMs: 1000, max: 2 });
    expect(limited('A')).toBe(false);
    expect(limited('A')).toBe(false);
    expect(limited('A')).toBe(true); // over max
    // Key B is untouched by A tripping.
    expect(limited('B')).toBe(false);
    expect(limited('B')).toBe(false);
    expect(limited('B')).toBe(true);
  });

  it('allows the max-th call, trips the (max+1)-th, and resets after the window', () => {
    const windowMs = 1000;
    const limited = createSlidingWindowLimiter({ windowMs, max: 3 });
    for (let i = 0; i < 3; i++) expect(limited('k')).toBe(false);
    expect(limited('k')).toBe(true);
    vi.advanceTimersByTime(windowMs + 1);
    expect(limited('k')).toBe(false); // window expired -> fresh budget
  });

  it('is key-type agnostic (IP string vs UUID token behave identically)', () => {
    const limited = createSlidingWindowLimiter({ windowMs: 1000, max: 1 });
    expect(limited('198.51.100.9')).toBe(false);
    expect(limited('198.51.100.9')).toBe(true);
    expect(limited('b3f1c2a4-7d8e-4f9a-9c2b-1e2d3f4a5b6c')).toBe(false);
    expect(limited('b3f1c2a4-7d8e-4f9a-9c2b-1e2d3f4a5b6c')).toBe(true);
  });

  it('does not leak or corrupt state across the cleanup interval', () => {
    const windowMs = 1000;
    const limited = createSlidingWindowLimiter({ windowMs, max: 1 });
    expect(limited('stale')).toBe(false);
    expect(limited('stale')).toBe(true);
    vi.advanceTimersByTime(300_000 + windowMs + 1); // past the 5-min cleanup
    expect(limited('fresh')).toBe(false);
    expect(limited('fresh')).toBe(true);
    expect(limited('stale')).toBe(false); // old key reset too
  });
});

describe('createIpFloodLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('allows the first N/minute and trips the (N+1)-th', () => {
    const limited = createIpFloodLimiter({ perMinute: 5, perHour: 1000 });
    const ip = '203.0.113.10';
    for (let i = 0; i < 5; i++) expect(limited(ip)).toBe(false);
    expect(limited(ip)).toBe(true);
  });

  it('enforces the hourly bound even when paced under the minute limit', () => {
    const limited = createIpFloodLimiter({ perMinute: 60, perHour: 120 });
    const ip = '203.0.113.11';
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 60; i++) expect(limited(ip)).toBe(false);
      vi.advanceTimersByTime(60_000 + 1000); // new minute, never trips the minute window
    }
    expect(limited(ip)).toBe(true); // 120 in the hour -> hourly bound trips
  });

  it('never limits falsy IPs and keeps IPs independent', () => {
    const limited = createIpFloodLimiter({ perMinute: 1, perHour: 10 });
    expect(limited(null)).toBe(false);
    expect(limited(undefined)).toBe(false);
    expect(limited('')).toBe(false);
    expect(limited('203.0.113.13')).toBe(false);
    expect(limited('203.0.113.13')).toBe(true);
    expect(limited('203.0.113.14')).toBe(false); // a different IP is unaffected
  });
});

describe('createKeyLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('never limits falsy keys (anonymous requests) and keys are independent', () => {
    const limited = createKeyLimiter({ windowMs: 3_600_000, max: 2 });
    expect(limited(null)).toBe(false);
    expect(limited(undefined)).toBe(false);
    expect(limited('')).toBe(false);
    expect(limited('token-a')).toBe(false);
    expect(limited('token-a')).toBe(false);
    expect(limited('token-a')).toBe(true);
    expect(limited('token-b')).toBe(false); // token-a tripping does not affect token-b
  });
});
