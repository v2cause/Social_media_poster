import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KmsPort } from './kms';

// Envelope encryption of secrets at rest (guide step 4.2, architecture 10). Every secret gets its
// own random data key (DEK, 32 bytes) and is encrypted with AES-256-GCM under a random 12-byte IV.
// The KMS wraps the DEK with its key-encryption key (KEK). The envelope describes itself:
//
//   ver(1) | kekIdLen(1) | kekId | wrappedDekLen(2) | wrappedDek | iv(12) | tag(16) | ciphertext
//
// The AAD (workspaceId:connectionId:field) binds the ciphertext to its row and field, so an
// envelope copied into another row does not open. It covers the ciphertext only: a key rotation
// wraps the DEK again with the new KEK and leaves IV, tag and ciphertext as they are.

export const ENVELOPE_VERSION = 1;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 255;
const MAX_WRAPPED_KEY_BYTES = 0xffff;

export type SealedSecretErrorCode = 'MALFORMED' | 'UNKNOWN_KEY' | 'INVALID';

const MESSAGES: Readonly<Record<SealedSecretErrorCode, string>> = {
  MALFORMED: 'The sealed secret is malformed.',
  UNKNOWN_KEY: 'The sealed secret was wrapped with a key that is not configured.',
  INVALID: 'The sealed secret could not be opened.',
};

/** Why a sealed secret could not be opened. The message never contains keys or plaintext. */
export class SealedSecretError extends Error {
  constructor(readonly code: SealedSecretErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SealedSecretError';
  }
}

interface Envelope {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const bufferOf = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function parse(sealed: Uint8Array): Envelope {
  const bytes = bufferOf(sealed);
  const malformed = (): never => {
    throw new SealedSecretError('MALFORMED');
  };
  if (bytes.length < 2 || bytes[0] !== ENVELOPE_VERSION) {
    malformed();
  }
  const keyIdLength = bytes[1] ?? 0;
  let offset = 2;
  if (keyIdLength === 0 || bytes.length < offset + keyIdLength + 2) {
    malformed();
  }
  const keyId = bytes.toString('utf8', offset, offset + keyIdLength);
  offset += keyIdLength;
  const wrappedLength = bytes.readUInt16BE(offset);
  offset += 2;
  if (wrappedLength === 0 || bytes.length < offset + wrappedLength + IV_BYTES + TAG_BYTES) {
    malformed();
  }
  const wrappedKey = bytes.subarray(offset, offset + wrappedLength);
  offset += wrappedLength;
  const iv = bytes.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = bytes.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  return { keyId, wrappedKey, iv, tag, ciphertext: bytes.subarray(offset) };
}

function assemble(envelope: Envelope): Buffer {
  const keyId = Buffer.from(envelope.keyId, 'utf8');
  if (keyId.length === 0 || keyId.length > MAX_KEY_ID_BYTES) {
    throw new RangeError(`A key id has 1 to ${String(MAX_KEY_ID_BYTES)} bytes.`);
  }
  if (envelope.wrappedKey.length === 0 || envelope.wrappedKey.length > MAX_WRAPPED_KEY_BYTES) {
    throw new RangeError(`A wrapped key has 1 to ${String(MAX_WRAPPED_KEY_BYTES)} bytes.`);
  }
  const lengths = Buffer.alloc(4);
  lengths[0] = ENVELOPE_VERSION;
  lengths[1] = keyId.length;
  lengths.writeUInt16BE(envelope.wrappedKey.length, 2);
  return Buffer.concat([
    lengths.subarray(0, 2),
    keyId,
    lengths.subarray(2, 4),
    envelope.wrappedKey,
    envelope.iv,
    envelope.tag,
    envelope.ciphertext,
  ]);
}

/** Encrypts plaintext under a fresh data key, which the KMS wraps with its active KEK. */
export async function seal(plaintext: Uint8Array, aad: string, kms: KmsPort): Promise<Buffer> {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const { keyId, wrappedKey } = await kms.wrapKey(dataKey);
    return assemble({ keyId, wrappedKey: bufferOf(wrappedKey), iv, tag, ciphertext });
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts an envelope; the AAD must be the one it was sealed with. */
export async function open(sealed: Uint8Array, aad: string, kms: KmsPort): Promise<Buffer> {
  const envelope = parse(sealed);
  const dataKey = bufferOf(await kms.unwrapKey(envelope.keyId, envelope.wrappedKey));
  try {
    if (dataKey.length !== DATA_KEY_BYTES) {
      throw new SealedSecretError('INVALID');
    }
    const decipher = createDecipheriv('aes-256-gcm', dataKey, envelope.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(envelope.tag);
    try {
      return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
      throw new SealedSecretError('INVALID');
    }
  } finally {
    dataKey.fill(0);
  }
}

/** The id of the KEK that wrapped the data key of an envelope. */
export const keyIdOf = (sealed: Uint8Array): string => parse(sealed).keyId;

/**
 * The envelope with its data key wrapped by the active KEK, or null when it already is. The
 * ciphertext is not decrypted; IV, tag and ciphertext stay unchanged.
 */
export async function rewrap(sealed: Uint8Array, kms: KmsPort): Promise<Buffer | null> {
  const envelope = parse(sealed);
  if (envelope.keyId === kms.activeKeyId) {
    return null;
  }
  const dataKey = await kms.unwrapKey(envelope.keyId, envelope.wrappedKey);
  try {
    const { keyId, wrappedKey } = await kms.wrapKey(dataKey);
    return assemble({ ...envelope, keyId, wrappedKey: bufferOf(wrappedKey) });
  } finally {
    bufferOf(dataKey).fill(0);
  }
}
