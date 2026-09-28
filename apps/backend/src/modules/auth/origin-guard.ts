import { FastifyRequest, FastifyReply } from 'fastify';

export function isOriginAllowed(requestOrigin: string | undefined, hostHeader: string | undefined, allowedOriginEnv?: string): boolean {
  // B3: Fail-closed — missing Origin is not automatically trusted.
  // Browsers always send Origin on cross-origin state-changing requests.
  // A missing Origin means either a non-browser client or a same-origin request
  // that passed Sec-Fetch-Site check before this is called.
  if (!requestOrigin) return false;

  try {
    const originUrl = new URL(requestOrigin);

    if (allowedOriginEnv) {
      const allowedOrigins = allowedOriginEnv.split(',').map((o) => o.trim()).filter(Boolean);
      for (const ao of allowedOrigins) {
        try {
          const allowedUrl = new URL(ao);
          if (originUrl.host === allowedUrl.host) return true;
        } catch {}
      }
    }

    if (hostHeader) {
      if (originUrl.host.toLowerCase() === hostHeader.toLowerCase()) return true;
    }

    // Localhost variations for development/testing
    if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
      if (hostHeader && (hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1'))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export async function verifyStateChangingOrigin(req: FastifyRequest, reply: FastifyReply) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return;
  }

  // Exempt server-to-server webhooks from browser origin checks
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/v1/telegram/webhook') || pathname.startsWith('/api/v1/webhooks/')) {
    return;
  }

  // 1. Check Sec-Fetch-Site if provided by browser — same-origin/same-site requests are safe
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') {
    if (secFetchSite.toLowerCase() === 'cross-site') {
      reply.status(403).send({
        error: {
          code: 'FORBIDDEN_ORIGIN',
          message: 'Ноқонуний сўров манбаи.',
        },
      });
      return reply;
    }
    // same-origin or same-site: safe, no further checks needed
    if (secFetchSite.toLowerCase() === 'same-origin' || secFetchSite.toLowerCase() === 'same-site') {
      return;
    }
  }

  // 2. Check Origin against configured allowed origin or Host header
  const origin = req.headers.origin;
  const host = req.headers.host;
  const allowedOriginEnv = process.env.APP_ORIGIN;

  if (typeof origin === 'string') {
    const allowed = isOriginAllowed(origin, host, allowedOriginEnv);
    if (!allowed) {
      reply.status(403).send({
        error: {
          code: 'FORBIDDEN_ORIGIN',
          message: 'Ноқонуний сўров манбаи.',
        },
      });
      return reply;
    }
    // Origin present and allowed
    return;
  }

  // B3: No Origin and no conclusive Sec-Fetch-Site — fail closed.
  // Legitimate browsers always send Origin on state-changing cross-origin requests.
  // Missing both headers is either a non-browser client or an old/buggy browser.
  reply.status(403).send({
    error: {
      code: 'FORBIDDEN_ORIGIN',
      message: 'Ноқонуний сўров манбаи.',
    },
  });
  return reply;
}
