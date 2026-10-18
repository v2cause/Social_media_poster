import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashes (guide step 8.4, ASVS 11.4.2): scrypt with N=2^15, r=8 and p=3, one of the
// settings of the OWASP Password Storage Cheat Sheet, at 32 MiB of memory per hash. A hash names
// its parameters, so they can rise later. Hashes in the format of Better Auth's default (N=2^14,
// r=16, p=1), as the demo seed wrote them before, still verify.

interface ScryptParameters {
  N: number;
  r: number;
  p: number;
}

const PREFIX = 'scrypt';
const CURRENT: ScryptParameters = { N: 2 ** 15, r: 8, p: 3 };
/** The default of Better Auth: "<salt as hex>:<key as hex>", with the hex text itself as salt. */
const BETTER_AUTH_DEFAULT: ScryptParameters = { N: 2 ** 14, r: 16, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;

const derive = (password: string, salt: Buffer | string, { N, r, p }: ScryptParameters): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // Node takes 32 MiB by default; scrypt needs 128 * N * r bytes and some room.
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r }, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });

const sameKey = (expected: Buffer, actual: Buffer): boolean =>
  expected.length === actual.length && timingSafeEqual(expected, actual);

/** Parameters within reason, so that a damaged hash cannot tie up memory and time. */
function parametersOf(n: string, r: string, p: string): ScryptParameters | null {
  const parameters = { N: Number(n), r: Number(r), p: Number(p) };
  const powerOfTwo = Number.isInteger(Math.log2(parameters.N));
  return powerOfTwo &&
    parameters.N >= 2 ** 10 &&
    parameters.N <= 2 ** 20 &&
    Number.isInteger(parameters.r) &&
    parameters.r >= 1 &&
    parameters.r <= 32 &&
    Number.isInteger(parameters.p) &&
    parameters.p >= 1 &&
    parameters.p <= 16
    ? parameters
    : null;
}

/** A hash of the password as "scrypt$N$r$p$<salt>$<key>", salt and key in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, CURRENT);
  const { N, r, p } = CURRENT;
  return [PREFIX, N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Whether the password matches the hash; false for a hash it cannot read. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts[0] === PREFIX) {
    const [, n = '', r = '', p = '', salt = '', key = ''] = parts;
    const parameters = parts.length === 6 ? parametersOf(n, r, p) : null;
    if (!parameters || !salt || !key) {
      return false;
    }
    const expected = Buffer.from(key, 'base64url');
    return sameKey(expected, await derive(password, Buffer.from(salt, 'base64url'), parameters));
  }
  const [salt, key, ...rest] = hash.split(':');
  if (!salt || !key || rest.length > 0 || !/^[0-9a-f]+$/.test(key)) {
    return false;
  }
  return sameKey(Buffer.from(key, 'hex'), await derive(password, salt, BETTER_AUTH_DEFAULT));
}
