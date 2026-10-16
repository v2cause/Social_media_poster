// Content Security Policy for every rendered page. The proxy creates a fresh nonce per request;
// Next.js reads it from the request header and attaches it to its own scripts. Scripts without
// the nonce do not run, and 'strict-dynamic' lets those scripts load the chunks they need.
//
// Styles allow 'unsafe-inline': Next.js renders style attributes (for example on its built-in
// error pages), and attributes cannot carry a nonce. Injected CSS cannot run code.
//
// Phase 3 (media) adds the object storage origin to img-src and connect-src.

/** 128 bits from the platform CSPRNG, base64 encoded. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function buildContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // React needs eval in development for its debugging features, never in production.
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'blob:', 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * Headers for every response, including static assets. The CSP itself is set per request in the
 * proxy, because it carries the nonce. HSTS is set by the TLS-terminating reverse proxy.
 */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Older browsers ignore frame-ancestors; this keeps clickjacking protection there too.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
];
