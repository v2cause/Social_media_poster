import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyMetaSignedRequest } from './signed-request';

// Guide step 4.13: the signed_request of the Meta callbacks is read only with a valid signature.

const SECRET = 'app-secret';

const signed = (payload: unknown, secret = SECRET): string => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${signature}.${encoded}`;
};

describe('verifyMetaSignedRequest', () => {
  it('reads the user of a request signed with the app secret', () => {
    const request = signed({ algorithm: 'HMAC-SHA256', user_id: '5550001', issued_at: 1_790_000_000 });
    expect(verifyMetaSignedRequest(request, SECRET)).toEqual({
      userId: '5550001',
      issuedAt: new Date(1_790_000_000_000),
    });
  });

  it('refuses another secret, a changed payload, another algorithm and broken input', () => {
    const valid = signed({ algorithm: 'HMAC-SHA256', user_id: '1' });
    const [signature] = valid.split('.');
    const changed = `${signature ?? ''}.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '2' })).toString('base64url')}`;

    expect(
      verifyMetaSignedRequest(signed({ algorithm: 'HMAC-SHA256', user_id: '1' }, 'other'), SECRET),
    ).toBeNull();
    expect(verifyMetaSignedRequest(changed, SECRET)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ algorithm: 'NONE', user_id: '1' }), SECRET)).toBeNull();
    expect(verifyMetaSignedRequest('no-dot', SECRET)).toBeNull();
    expect(verifyMetaSignedRequest('a.b.c', SECRET)).toBeNull();
  });
});
