import { describe, expect, it } from 'vitest';

import {
  accountSecretAad,
  ChannelUnavailableError,
  CompleteAuthorization,
  ConfirmConnection,
  connectionSecretAad,
  DisconnectAccount,
  GetPendingConnection,
  InvalidAccountSelectionError,
  NotPermittedError,
  PendingConnectionNotFoundError,
  SocialAccountNotFoundError,
  StartConnection,
  type ContentActor,
} from '../../src';
import { createChannelTestbed, fakeSealer, type ChannelTestbed } from '../in-memory-channels';

// The OAuth flow of guide step 4.5: start, callback, selection, confirmation, reconnect and
// disconnect, against in-memory stores and a scriptable connector.

const owner: ContentActor = {
  userId: 'u-owner',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  role: 'OWNER',
};
const editor: ContentActor = { ...owner, userId: 'u-editor', role: 'EDITOR' };
const SLUG = 'nordlicht';

const decode = (bytes: Uint8Array | null): string => (bytes ? new TextDecoder().decode(bytes) : '');

/** Starts a connection and returns the state the platform sends back. */
async function start(bed: ChannelTestbed, platform: 'FACEBOOK' | 'X' = 'FACEBOOK'): Promise<string> {
  const { authorizationUrl } = await new StartConnection(bed).execute({
    actor: owner,
    workspaceSlug: SLUG,
    platform,
  });
  return new URL(authorizationUrl).searchParams.get('state') ?? '';
}

/** Runs the flow up to the parked consent and returns its id. */
async function consent(bed: ChannelTestbed, platform: 'FACEBOOK' | 'X' = 'FACEBOOK'): Promise<string> {
  const outcome = await new CompleteAuthorization(bed).execute({
    userId: owner.userId,
    platform,
    state: await start(bed, platform),
    code: 'good',
    error: null,
  });
  if (outcome.status !== 'pending') {
    throw new Error(`expected a pending consent, got ${outcome.reason}`);
  }
  return outcome.pendingId;
}

describe('StartConnection', () => {
  it('keeps the state with the PKCE verifier on the server and sends only the challenge', async () => {
    const bed = createChannelTestbed();
    const { authorizationUrl } = await new StartConnection(bed).execute({
      actor: owner,
      workspaceSlug: SLUG,
      platform: 'X',
    });

    const url = new URL(authorizationUrl);
    const state = url.searchParams.get('state') ?? '';
    expect(bed.states.states.get(state)).toEqual({
      userId: owner.userId,
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      workspaceSlug: SLUG,
      platform: 'X',
      method: 'API',
      redirectUri: 'http://localhost:3000/api/oauth/x/callback',
      codeVerifier: 'verifier-2',
      reconnectAccountId: null,
    });
    expect(url.searchParams.get('code_challenge')).toBe('challenge-2');
    expect(authorizationUrl).not.toContain('verifier');
  });

  it('asks for no PKCE where the platform does not use it', async () => {
    const bed = createChannelTestbed();
    const state = await start(bed);
    expect(bed.states.states.get(state)?.codeVerifier).toBeNull();
  });

  it('is for owners and admins, and only for platforms on offer', async () => {
    const bed = createChannelTestbed();
    await expect(
      new StartConnection(bed).execute({ actor: editor, workspaceSlug: SLUG, platform: 'FACEBOOK' }),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      new StartConnection(bed).execute({ actor: owner, workspaceSlug: SLUG, platform: 'LINKEDIN' }),
    ).rejects.toBeInstanceOf(ChannelUnavailableError);
  });
});

describe('CompleteAuthorization', () => {
  it('parks the sealed tokens of the consent with the accounts it reaches', async () => {
    const bed = createChannelTestbed();
    bed.facebook.grantedScopes = ['read', 'write'];
    const state = await start(bed);

    const outcome = await new CompleteAuthorization(bed).execute({
      userId: owner.userId,
      platform: 'FACEBOOK',
      state,
      code: 'good',
      error: null,
    });

    expect(outcome).toEqual({ status: 'pending', workspaceSlug: SLUG, pendingId: 'token-2' });
    const pending = bed.pendings.pendings.get('token-2');
    expect(pending).toMatchObject({
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      externalUserId: 'user-1',
      requestedScopes: ['read', 'write', 'insights'],
      grantedScopes: ['read', 'write'],
      expiresAt: new Date('2026-10-16T12:15:00Z'),
    });
    expect(pending?.accounts[0]).not.toHaveProperty('accessToken');
    const sealed = decode(pending?.sealedSecrets ?? null);
    expect(sealed.startsWith('ws-1:pending.token-2:token_set|')).toBe(true);
    expect(JSON.parse(sealed.slice(sealed.indexOf('|') + 1))).toMatchObject({
      accessToken: 'access-1',
      accounts: { 'page-1': 'page-token-1' },
    });
    expect(bed.facebook.exchanges).toEqual([
      { code: 'good', redirectUri: 'http://localhost:3000/api/oauth/facebook/callback', codeVerifier: null },
    ]);
  });

  it('hands the PKCE verifier of the state to the code exchange', async () => {
    const bed = createChannelTestbed();
    await consent(bed, 'X');
    expect(bed.x.exchanges[0]?.codeVerifier).toBe('verifier-2');
  });

  it('uses a state once and only for the user who started it', async () => {
    const bed = createChannelTestbed();
    const complete = new CompleteAuthorization(bed);
    const state = await start(bed);

    await expect(
      complete.execute({ userId: 'u-other', platform: 'FACEBOOK', state, code: 'good', error: null }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'USER_MISMATCH',
      workspaceSlug: SLUG,
    });
    await expect(
      complete.execute({ userId: owner.userId, platform: 'FACEBOOK', state, code: 'good', error: null }),
    ).resolves.toEqual({ status: 'failed', reason: 'STATE_INVALID', workspaceSlug: null });
    expect(bed.facebook.exchanges).toEqual([]);
  });

  it('refuses a state on the callback of another platform', async () => {
    const bed = createChannelTestbed();
    const state = await start(bed, 'X');

    await expect(
      new CompleteAuthorization(bed).execute({
        userId: owner.userId,
        platform: 'FACEBOOK',
        state,
        code: 'good',
        error: null,
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'STATE_INVALID' });
    expect(bed.x.exchanges).toEqual([]);
  });

  it('reports a refused consent and a failed code exchange', async () => {
    const bed = createChannelTestbed();
    const complete = new CompleteAuthorization(bed);

    for (const error of ['access_denied', 'user_cancelled_authorize']) {
      await expect(
        complete.execute({
          userId: owner.userId,
          platform: 'FACEBOOK',
          state: await start(bed),
          code: null,
          error,
        }),
      ).resolves.toMatchObject({ status: 'failed', reason: 'ACCESS_DENIED' });
    }
    await expect(
      complete.execute({
        userId: owner.userId,
        platform: 'FACEBOOK',
        state: await start(bed),
        code: null,
        error: 'server_error',
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: 'PROVIDER_ERROR' });
    const failed = await complete.execute({
      userId: owner.userId,
      platform: 'FACEBOOK',
      state: await start(bed),
      code: 'bad',
      error: null,
    });
    expect(failed).toMatchObject({ status: 'failed', reason: 'EXCHANGE_FAILED', workspaceSlug: SLUG });
    expect(bed.pendings.pendings.size).toBe(0);
  });
});

describe('GetPendingConnection', () => {
  it('shows the missing scopes and which accounts are connected already', async () => {
    const bed = createChannelTestbed();
    bed.facebook.grantedScopes = ['read', 'write'];
    const first = await consent(bed);
    await new ConfirmConnection(bed).execute({ actor: owner, pendingId: first, externalIds: ['page-1'] });

    const view = await new GetPendingConnection(bed).execute({ actor: owner, pendingId: await consent(bed) });

    expect(view.missingScopes).toEqual(['insights']);
    expect(view.accounts.map((account) => [account.externalId, account.connected])).toEqual([
      ['page-1', true],
      ['page-2', false],
    ]);
  });

  it('shows a consent only to the user who gave it, in its workspace and before it expires', async () => {
    const bed = createChannelTestbed();
    const pendingId = await consent(bed);
    const get = new GetPendingConnection(bed);

    for (const actor of [
      { ...owner, userId: 'u-admin', role: 'ADMIN' as const },
      { ...owner, workspaceId: 'ws-2' },
    ]) {
      await expect(get.execute({ actor, pendingId })).rejects.toBeInstanceOf(PendingConnectionNotFoundError);
    }
    const later = new GetPendingConnection({
      ...bed,
      clock: { now: () => new Date('2026-10-16T12:15:00Z') },
    });
    await expect(later.execute({ actor: owner, pendingId })).rejects.toBeInstanceOf(
      PendingConnectionNotFoundError,
    );
  });
});

describe('ConfirmConnection', () => {
  it('stores the connection and the picked accounts with tokens sealed for their rows', async () => {
    const bed = createChannelTestbed();
    const pendingId = await consent(bed);

    const confirmed = await new ConfirmConnection(bed).execute({
      actor: owner,
      pendingId,
      externalIds: ['page-1', 'page-2', 'page-1'],
    });

    expect(confirmed).toEqual({ connectionId: 'ch-1', accountIds: ['ch-2', 'ch-3'] });
    const connection = bed.unitOfWork.state.connections.get('ch-1');
    expect(connection).toMatchObject({ status: 'ACTIVE', externalUserId: 'user-1', version: 0 });
    await expect(
      fakeSealer.open(
        connection?.accessTokenSealed ?? new Uint8Array(),
        connectionSecretAad('ws-1', 'ch-1', 'access_token'),
      ),
    ).resolves.toBe('access-1');
    await expect(
      fakeSealer.open(
        connection?.refreshTokenSealed ?? new Uint8Array(),
        connectionSecretAad('ws-1', 'ch-1', 'refresh_token'),
      ),
    ).resolves.toBe('refresh-1');
    const [page1, page2] = [
      bed.unitOfWork.state.accounts.get('ch-2'),
      bed.unitOfWork.state.accounts.get('ch-3'),
    ];
    await expect(
      fakeSealer.open(page1?.accessTokenSealed ?? new Uint8Array(), accountSecretAad('ws-1', 'ch-1', 'ch-2')),
    ).resolves.toBe('page-token-1');
    expect(page2?.accessTokenSealed).toBeNull();
    expect(bed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({
        action: 'channel.connect',
        targetId: 'ch-1',
        metadata: { platform: 'FACEBOOK', method: 'API', accounts: 2, missingScopes: [] },
      }),
    ]);
    expect(bed.pendings.pendings.size).toBe(0);
  });

  it('renews the connection of the same platform user and connects its accounts again', async () => {
    const bed = createChannelTestbed();
    const confirm = new ConfirmConnection(bed);
    await confirm.execute({ actor: owner, pendingId: await consent(bed), externalIds: ['page-1'] });
    await new DisconnectAccount(bed).execute({ actor: owner, accountId: 'ch-2' });

    const again = await confirm.execute({
      actor: owner,
      pendingId: await consent(bed),
      externalIds: ['page-1'],
    });

    expect(again).toEqual({ connectionId: 'ch-1', accountIds: ['ch-2'] });
    expect(bed.unitOfWork.state.connections.get('ch-1')).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(bed.unitOfWork.state.accounts.get('ch-2')).toMatchObject({
      disconnectedAt: null,
      connectionId: 'ch-1',
    });
    expect(bed.unitOfWork.state.audit.map((entry) => entry.action)).toEqual([
      'channel.connect',
      'channel.disconnect',
      'channel.reconnect',
    ]);
  });

  it('refuses accounts the consent does not reach and keeps the consent', async () => {
    const bed = createChannelTestbed();
    const pendingId = await consent(bed);

    await expect(
      new ConfirmConnection(bed).execute({ actor: owner, pendingId, externalIds: ['page-1', 'page-9'] }),
    ).rejects.toBeInstanceOf(InvalidAccountSelectionError);
    expect(bed.unitOfWork.state.connections.size).toBe(0);
    expect(bed.pendings.pendings.has(pendingId)).toBe(true);
    await expect(
      new ConfirmConnection(bed).execute({ actor: editor, pendingId, externalIds: ['page-1'] }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});

describe('the connected accounts of the plan (guide step 7.4)', () => {
  it('starts a new connection only while the plan has room for another account', async () => {
    const bed = createChannelTestbed();
    await new ConfirmConnection(bed).execute({
      actor: owner,
      pendingId: await consent(bed),
      externalIds: ['page-1'],
    });
    bed.accounts.max = 1;

    await expect(start(bed)).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxSocialAccounts', max: 1 },
    });
    // A reconnect adds no account.
    await expect(
      new StartConnection(bed).execute({ actor: owner, workspaceSlug: SLUG, reconnectAccountId: 'ch-2' }),
    ).resolves.toHaveProperty('authorizationUrl');
  });

  it('counts only the picked accounts that are not connected yet and keeps the consent', async () => {
    const bed = createChannelTestbed();
    const confirm = new ConfirmConnection(bed);
    await confirm.execute({ actor: owner, pendingId: await consent(bed), externalIds: ['page-1'] });
    const pendingId = await consent(bed);
    bed.accounts.max = 1;

    await expect(
      confirm.execute({ actor: owner, pendingId, externalIds: ['page-1', 'page-2'] }),
    ).rejects.toMatchObject({ params: { limit: 'maxSocialAccounts', max: 1 } });
    expect(bed.pendings.pendings.has(pendingId)).toBe(true);
    expect(bed.unitOfWork.state.accounts.size).toBe(1);
    await expect(confirm.execute({ actor: owner, pendingId, externalIds: ['page-1'] })).resolves.toEqual({
      connectionId: 'ch-1',
      accountIds: ['ch-2'],
    });
    // The start asks early; the confirmation counts again under the lock of the organization.
    expect(bed.accounts.asked).toEqual([
      { adding: 1, locked: false },
      { adding: 1, locked: true },
      { adding: 1, locked: false },
      { adding: 1, locked: true },
      { adding: 0, locked: true },
    ]);
  });
});

describe('reconnect and disconnect', () => {
  it('starts a reconnect with the platform and method of the account', async () => {
    const bed = createChannelTestbed();
    await new ConfirmConnection(bed).execute({
      actor: owner,
      pendingId: await consent(bed),
      externalIds: ['page-1'],
    });

    const { authorizationUrl } = await new StartConnection(bed).execute({
      actor: owner,
      workspaceSlug: SLUG,
      reconnectAccountId: 'ch-2',
    });

    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    expect(bed.states.states.get(state)).toMatchObject({ platform: 'FACEBOOK', reconnectAccountId: 'ch-2' });
    await expect(
      new StartConnection(bed).execute({ actor: owner, workspaceSlug: SLUG, reconnectAccountId: 'missing' }),
    ).rejects.toBeInstanceOf(SocialAccountNotFoundError);
  });

  it('revokes the grant at the platform with the last account only', async () => {
    const bed = createChannelTestbed();
    await new ConfirmConnection(bed).execute({
      actor: owner,
      pendingId: await consent(bed),
      externalIds: ['page-1', 'page-2'],
    });
    const disconnect = new DisconnectAccount(bed);

    await expect(disconnect.execute({ actor: owner, accountId: 'ch-2' })).resolves.toEqual({
      platformRevoke: 'skipped',
    });
    expect(bed.unitOfWork.state.accounts.get('ch-2')).toMatchObject({ accessTokenSealed: null });
    expect(bed.unitOfWork.state.connections.get('ch-1')?.status).toBe('ACTIVE');

    await expect(disconnect.execute({ actor: owner, accountId: 'ch-3' })).resolves.toEqual({
      platformRevoke: 'done',
    });
    expect(bed.facebook.revoked).toEqual([
      expect.objectContaining({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
    ]);
    expect(bed.unitOfWork.state.connections.get('ch-1')).toMatchObject({
      status: 'REVOKED',
      accessTokenSealed: null,
      refreshTokenSealed: null,
    });
    await expect(disconnect.execute({ actor: owner, accountId: 'ch-3' })).rejects.toBeInstanceOf(
      SocialAccountNotFoundError,
    );
  });

  it('disconnects locally even when the platform does not confirm the revoke', async () => {
    const bed = createChannelTestbed();
    await new ConfirmConnection(bed).execute({
      actor: owner,
      pendingId: await consent(bed),
      externalIds: ['page-1'],
    });
    bed.facebook.revoke = () => Promise.reject(new Error('platform down'));

    const result = await new DisconnectAccount(bed).execute({ actor: owner, accountId: 'ch-2' });

    expect(result).toMatchObject({ platformRevoke: 'failed' });
    expect(bed.unitOfWork.state.connections.get('ch-1')?.status).toBe('REVOKED');
  });
});
