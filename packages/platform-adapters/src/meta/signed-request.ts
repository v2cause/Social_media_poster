import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

// The signed_request of the Meta callbacks for a removed app and for data deletion (guide step
// 4.13): "<signature>.<payload>", both base64url, the signature an HMAC-SHA256 of the encoded
// payload with the app secret. Only a request with a valid signature and algorithm is read.

const payloadSchema = z
  .object({
    algorithm: z.string(),
    user_id: z.union([z.string(), z.number()]).transform(String),
    issued_at: z.number().int().optional(),
  })
  .loose();

export interface MetaSignedRequest {
  /** The app-scoped id of the user the request is about. */
  userId: string;
  issuedAt: Date | null;
}

/** The content of a signed request; null when its signature or form is not valid. */
export function verifyMetaSignedRequest(signedRequest: string, appSecret: string): MetaSignedRequest | null {
  const [encodedSignature, encodedPayload, ...rest] = signedRequest.split('.');
  if (!encodedSignature || !encodedPayload || rest.length > 0) {
    return null;
  }
  const expected = createHmac('sha256', appSecret).update(encodedPayload).digest();
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const payload = payloadSchema.safeParse(json);
  if (!payload.success || payload.data.algorithm.toUpperCase() !== 'HMAC-SHA256') {
    return null;
  }
  return {
    userId: payload.data.user_id,
    issuedAt: payload.data.issued_at === undefined ? null : new Date(payload.data.issued_at * 1000),
  };
}
