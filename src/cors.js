// A configurable origin gate + CORS header helper for serverless endpoints. Pass your own
// allowlist; localhost / 127.0.0.1 / capacitor://localhost are convenient dev defaults you can
// turn off with `allowLocalhost: false`.

/**
 * @param {object} [o]
 * @param {string[]} [o.hosts=[]]        exact hostnames allowed, e.g. `['app.example.com']`
 * @param {string[]} [o.suffixes=[]]     host suffixes allowed, e.g. `['.example.com', '.vercel.app']`
 * @param {boolean}  [o.allowLocalhost=true]  allow localhost / 127.0.0.1 / capacitor://localhost
 * @returns {{ originAllowed: (req: any) => boolean, setCorsHeaders: (req: any, res: any) => void }}
 */
export function createOriginGate({ hosts = [], suffixes = [], allowLocalhost = true } = {}) {
  const hostSet = new Set(hosts);

  function originAllowed(req) {
    const src = req.headers.origin || req.headers.referer || '';
    if (!src) return false;
    // Exact match (or a real referer path form) — NOT a prefix, so `capacitor://localhost.evil.com`
    // and `capacitor://localhostEVIL` are correctly rejected.
    if (allowLocalhost && (src === 'capacitor://localhost' || src.startsWith('capacitor://localhost/'))) {
      return true;
    }
    try {
      const host = new URL(src).hostname;
      if (hostSet.has(host)) return true;
      if (suffixes.some((s) => host.endsWith(s))) return true;
      if (allowLocalhost && (host === 'localhost' || host === '127.0.0.1')) return true;
      return false;
    } catch {
      return false;
    }
  }

  function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '';
    if (origin && originAllowed(req)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }

  return { originAllowed, setCorsHeaders };
}
