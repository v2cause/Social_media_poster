import type { NextFunction, Request, Response } from 'express';

// CSRF protection for every API route including /api/auth (architecture 10). The session cookie
// is SameSite=Lax, and in addition a state-changing request must come from the app's own origin.
// Browsers send Origin and Sec-Fetch-Site with every such request; other clients (webhooks,
// scripts) send neither and carry no session cookie of a victim.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_SITE_FETCH = new Set(['same-origin', 'none']);

export function createOriginCheckMiddleware(appUrl: string) {
  const allowedOrigin = new URL(appUrl).origin;

  return function originCheck(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    const foreignOrigin = origin !== undefined && origin !== allowedOrigin;
    const crossSite = fetchSite !== undefined && !SAME_SITE_FETCH.has(fetchSite);
    if (foreignOrigin || crossSite) {
      res
        .status(403)
        .type('application/problem+json')
        .json({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'ORIGIN_REJECTED',
          detail: 'The request does not come from the application.',
          traceId: typeof req.id === 'string' ? req.id : 'unknown',
        });
      return;
    }
    next();
  };
}
