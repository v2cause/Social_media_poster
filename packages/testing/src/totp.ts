import { createHmac } from 'node:crypto';

// RFC 6238 time-based one-time passwords (SHA-1, 30 s, 6 digits), as authenticator apps compute
// them. Tests use it to complete the two-factor flows.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value === -1) {
      throw new Error('invalid base32 secret');
    }
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

/** The current code for an otpauth:// URI or a base32 secret. */
export function totpCode(uriOrSecret: string, now = Date.now()): string {
  const secret = uriOrSecret.startsWith('otpauth://')
    ? (new URL(uriOrSecret).searchParams.get('secret') ?? '')
    : uriOrSecret;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Hands out codes of one secret that were not handed out before: the API takes every code once
 * (guide step 8.4). The current step comes first, then the next and the previous one, which the
 * API accepts as well, so one test can verify up to three times within one step of 30 seconds.
 */
export function totpCodes(uriOrSecret: string): () => string {
  const used = new Set<string>();
  return () => {
    const now = Date.now();
    for (const offset of [0, 30_000, -30_000]) {
      const code = totpCode(uriOrSecret, now + offset);
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
    throw new Error('every code around the current step was used; wait for the next step');
  };
}
