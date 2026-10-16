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
