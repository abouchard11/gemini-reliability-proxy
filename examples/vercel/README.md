# Vercel example

A compact serverless endpoint (`api/generate.js`) that wires the reliability core into a real
HTTP proxy: origin gating, per-IP + per-user rate limiting, a prompt-length cap, and a model
fallback chain with family-specific reasoning config.

## Run it

```bash
npm install gemini-reliability-proxy
cp .env.example .env.local          # set GEMINI_API_KEY (server-only)
vercel dev                          # or drop api/generate.js into any Vercel project
```

Then:

```bash
curl -X POST http://localhost:3000/api/generate \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost' \
  -d '{"prompt":"Write one witty sentence about caching."}'
```

The key never leaves the server; the client only ever talks to `/api/generate`.
