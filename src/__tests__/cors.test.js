import { describe, expect, it } from 'vitest';
import { createOriginGate } from '../cors.js';

const reqWith = (origin) => ({ headers: { origin } });

describe('createOriginGate', () => {
  const gate = createOriginGate({ hosts: ['app.example.com'], suffixes: ['.example.com', '.vercel.app'] });

  it('allows exact hosts, suffixes, localhost, and capacitor://localhost', () => {
    expect(gate.originAllowed(reqWith('https://app.example.com'))).toBe(true);
    expect(gate.originAllowed(reqWith('https://preview.example.com'))).toBe(true);
    expect(gate.originAllowed(reqWith('https://foo.vercel.app'))).toBe(true);
    expect(gate.originAllowed(reqWith('http://localhost:3000'))).toBe(true);
    expect(gate.originAllowed(reqWith('capacitor://localhost'))).toBe(true);
  });

  it('rejects unknown origins, empty origin, missing origin, and malformed URLs', () => {
    expect(gate.originAllowed(reqWith('https://evil.com'))).toBe(false);
    expect(gate.originAllowed(reqWith(''))).toBe(false);
    expect(gate.originAllowed({ headers: {} })).toBe(false);
    expect(gate.originAllowed(reqWith('not a url'))).toBe(false);
  });

  it('does not let a spoofed capacitor origin through (exact match, not prefix)', () => {
    expect(gate.originAllowed(reqWith('capacitor://localhost.evil.com'))).toBe(false);
    expect(gate.originAllowed(reqWith('capacitor://localhostEVIL'))).toBe(false);
    expect(gate.originAllowed(reqWith('capacitor://localhost/index.html'))).toBe(true); // real referer path form
  });

  it('can disallow localhost / capacitor when configured', () => {
    const strict = createOriginGate({ hosts: ['app.example.com'], allowLocalhost: false });
    expect(strict.originAllowed(reqWith('http://localhost:3000'))).toBe(false);
    expect(strict.originAllowed(reqWith('capacitor://localhost'))).toBe(false);
    expect(strict.originAllowed(reqWith('https://app.example.com'))).toBe(true);
  });

  it('setCorsHeaders reflects an allowed origin and skips a disallowed one', () => {
    const allow = {};
    gate.setCorsHeaders(reqWith('https://app.example.com'), { setHeader: (k, v) => (allow[k] = v) });
    expect(allow['Access-Control-Allow-Origin']).toBe('https://app.example.com');

    const deny = {};
    gate.setCorsHeaders(reqWith('https://evil.com'), { setHeader: (k, v) => (deny[k] = v) });
    expect(deny['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
