import { isIP } from 'node:net';

import { PlatformError } from '@smp/core';

// Instagram fetches every image itself: "We cURL media used in publishing attempts, so the media
// must be hosted on a publicly accessible server at the time of the attempt." Images have no byte
// upload; the resumable upload (rupload.facebook.com) takes videos only. Checked 2026-11-25:
// https://developers.facebook.com/documentation/instagram-platform/content-publishing,
// https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
//
// A local storage (http://localhost:8333/...) is out of Meta's reach. The adapter therefore takes
// a public base URL, for example an HTTPS tunnel to the storage, and moves the path and the query
// of the signed URL onto it. The signature of an S3 URL covers the Host header, so the tunnel has
// to forward with the Host the URL was signed for (for example localhost:8333), or the storage has
// to sign for the public host itself. Without a public URL the publish fails before any call.

/** Moves a media URL onto the public base URL, if one is set, and checks that Meta can reach it. */
export function publicMediaUrl(mediaUrl: string, publicBaseUrl: string | undefined): string {
  const source = parse(mediaUrl);
  let target = source;
  if (publicBaseUrl !== undefined) {
    const base = parse(publicBaseUrl);
    const prefix = base.pathname.replace(/\/+$/, '');
    target = new URL(`${base.origin}${prefix}${source.pathname}${source.search}`);
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw notPublic('it is not an HTTP URL');
  }
  if (!isPublicHost(target.hostname)) {
    throw notPublic(
      publicBaseUrl === undefined
        ? 'it points to a local or private host; set the public media base URL (for example an HTTPS tunnel to the storage)'
        : 'the public media base URL points to a local or private host',
    );
  }
  return target.toString();
}

function parse(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw notPublic('it is not a valid URL');
  }
}

function notPublic(reason: string): PlatformError {
  return new PlatformError(
    'VALIDATION_REJECTED',
    `Instagram cannot fetch the media: ${reason}. Instagram loads images from a public URL itself.`,
    { retryable: false },
  );
}

/** False for localhost, single-label names, .local/.internal and private or reserved addresses. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0) {
    return false;
  }
  const version = isIP(host);
  if (version === 4) {
    return isPublicIpv4(host);
  }
  if (version === 6) {
    return isPublicIpv6(host);
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return false;
  }
  if (!host.includes('.')) {
    // Docker service names such as "seaweedfs" or "minio".
    return false;
  }
  return !['.local', '.internal', '.lan', '.home', '.test', '.invalid', '.example'].some((suffix) =>
    host.endsWith(suffix),
  );
}

function isPublicIpv4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  // Carrier-grade NAT, 100.64.0.0/10.
  return !(a === 100 && b >= 64 && b <= 127);
}

function isPublicIpv6(host: string): boolean {
  if (host === '::' || host === '::1') {
    return false;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped?.[1] !== undefined) {
    return isPublicIpv4(mapped[1]);
  }
  // Unique local fc00::/7 and link-local fe80::/10.
  return !/^(fc|fd|fe8|fe9|fea|feb)/.test(host);
}
