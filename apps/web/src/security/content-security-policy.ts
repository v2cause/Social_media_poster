// Content Security Policy for every rendered page. The proxy creates a fresh nonce per request;
// Next.js reads it from the request header and attaches it to its own scripts. Scripts without
// the nonce do not run, and 'strict-dynamic' lets those scripts load the chunks they need.
//
// Styles allow 'unsafe-inline': Next.js renders style attributes (for example on its built-in
// error pages), and attributes cannot carry a nonce. Injected CSS cannot run code.
//
// The object storage is the only other origin: the browser uploads straight into it and shows
// thumbnails from it, both through presigned URLs (guide step 3.6).

/** 128 bits from the platform CSPRNG, base64 encoded. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The origins of the object storage as the browser reaches it: S3_PUBLIC_ENDPOINT, or
 * S3_ENDPOINT when the services and the browser share the address. With virtual-hosted URLs
 * (S3_FORCE_PATH_STYLE=false) the bucket is a subdomain, so its subdomains are allowed too.
 */
export function storageOrigins(env: Readonly<Record<string, string | undefined>>): string[] {
  const endpoint = env['S3_PUBLIC_ENDPOINT'] || env['S3_ENDPOINT'];
  if (!endpoint) {
    return [];
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return [];
  }
  return env['S3_FORCE_PATH_STYLE'] === 'false'
    ? [url.origin, `${url.protocol}//*.${url.host}`]
    : [url.origin];
}

export function buildContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
  storage: readonly string[] = [],
): string {
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
    'img-src': ["'self'", 'blob:', 'data:', ...storage],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...storage],
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
