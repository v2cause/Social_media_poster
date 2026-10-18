import { createPrismaClient, type PrismaClient } from '@smp/db';
import { totpCode } from '@smp/testing';
import { symmetricDecrypt, symmetricEncrypt, type SecretConfig } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reencryptTwoFactor } from '../src/modules/identity/reencrypt-two-factor';
import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { PASSWORD, signUpVerified } from './support/browser';

// Guide step 8.4 (docs/runbooks/secret-rotation.md): a rotation of the keys of Better Auth. The
// API runs with a new current key in BETTER_AUTH_SECRETS and the old BETTER_AUTH_SECRET. A second
// factor encrypted with the old key still works; the re-encryption moves it to the new key, and it
// keeps working.

const OLD_SECRET = 'test-only-better-auth-secret-do-not-use-elsewhere';
const NEW_SECRET = 'a-new-test-only-better-auth-secret-of-2026';
const KEYS: SecretConfig = { keys: new Map([[1, NEW_SECRET]]), currentVersion: 1, legacySecret: OLD_SECRET };

describe('a rotation of the keys of Better Auth', () => {
  let api: ApiTestApp | undefined;
  let prisma: PrismaClient | undefined;

  const started = () => {
    if (!api || !prisma) {
      throw new Error('API is not running');
    }
    return { api, prisma };
  };

  beforeAll(async () => {
    api = await startApiTestApp({ env: { BETTER_AUTH_SECRETS: `1:${NEW_SECRET}` } });
    prisma = createPrismaClient(api.database.url('app_user'));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await api?.close();
  });

  it('keeps the second factor working before and after the re-encryption', async () => {
    const email = 'rotating@example.test';
    const agent = await signUpVerified(started().api, email);
    const enabled = await agent.post('/api/auth/two-factor/enable').send({ password: PASSWORD }).expect(200);
    const { totpURI } = enabled.body as { totpURI: string };
    await agent
      .post('/api/auth/two-factor/verify-totp')
      .send({ code: totpCode(totpURI) })
      .expect(200);

    // New payloads carry the current version; as before the rotation, the old key alone sealed it.
    const { prisma: db } = started();
    const [row] = await db.twoFactor.findMany({ select: { id: true, secret: true, backupCodes: true } });
    if (!row) {
      throw new Error('no second factor');
    }
    expect(row.secret.startsWith('$ba$1$')).toBe(true);
    const secret = await symmetricDecrypt({ key: KEYS, data: row.secret });
    const backupCodes = await symmetricDecrypt({ key: KEYS, data: row.backupCodes });
    await db.twoFactor.update({
      where: { id: row.id },
      data: {
        secret: await symmetricEncrypt({ key: OLD_SECRET, data: secret }),
        backupCodes: await symmetricEncrypt({ key: OLD_SECRET, data: backupCodes }),
      },
    });

    const signInWithSecondFactor = async () => {
      await agent.post('/api/auth/sign-out').send({}).expect(200);
      const signedIn = await agent
        .post('/api/auth/sign-in/email')
        .send({ email, password: PASSWORD })
        .expect(200);
      expect(signedIn.body).toMatchObject({ twoFactorRedirect: true });
      await agent
        .post('/api/auth/two-factor/verify-totp')
        .send({ code: totpCode(totpURI) })
        .expect(200);
    };
    await signInWithSecondFactor();

    await expect(reencryptTwoFactor(db, KEYS)).resolves.toEqual({
      checked: 1,
      reencrypted: 1,
      current: 0,
      changedMeanwhile: 0,
      failed: 0,
    });
    const after = await db.twoFactor.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.secret.startsWith('$ba$1$')).toBe(true);
    expect(after.backupCodes.startsWith('$ba$1$')).toBe(true);
    await expect(symmetricDecrypt({ key: KEYS, data: after.secret })).resolves.toBe(secret);
    await expect(symmetricDecrypt({ key: KEYS, data: after.backupCodes })).resolves.toBe(backupCodes);

    await signInWithSecondFactor();
    await expect(reencryptTwoFactor(db, KEYS)).resolves.toMatchObject({ reencrypted: 0, current: 1 });
  });
});
