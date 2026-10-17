import type { ContentActor } from '../../content/domain/types';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import {
  BrowserLoginNotAwaitingCodeError,
  BrowserLoginNotFoundError,
  SocialAccountNotFoundError,
  TooManyBrowserLoginsError,
  XBrowserUnavailableError,
} from '../domain/errors';
import {
  OPEN_BROWSER_LOGIN_STATUSES,
  type BrowserLogin,
  type BrowserLoginAad,
  type BrowserLoginEvents,
  type BrowserLoginFailure,
  type BrowserLoginQueue,
  type BrowserLoginStore,
} from '../ports/browser-login';
import type { ChannelUnitOfWork, ConnectionGrant } from '../ports/channel-store';
import type { SecretSealer } from '../ports/secrets';
import { assertCanManageChannels, channelScopeOf } from './dependencies';
import type { XBrowserGate } from './x-browser-access';

// The interactive login of X without the API (guide step 6.4, architecture 4.3). The API seals
// the user name and the password with the session keyring into the command of the browser worker
// and keeps nothing of them; the login itself lives for five minutes in Redis. The browser worker
// reports its steps on xb-results: X asks for a code (AWAITING_2FA), which the API passes on
// sealed through Redis (VERIFYING), and in the end the X user with the sealed storage state,
// which the role "publisher" stores as the browser connection of X with its account (SUCCEEDED),
// or why the login ended without one (FAILED). Each step reaches the browser of the user who
// started the login.

/** The whole login, codes included, ends after this. */
export const BROWSER_LOGIN_TTL_MS = 5 * 60_000;
/** The browser worker does not start a login that waited longer in its queue. */
export const BROWSER_LOGIN_START_WINDOW_MS = 2 * 60_000;
/** Starts per workspace and hour; X watches out for many logins from one address. */
export const BROWSER_LOGINS_PER_HOUR = 5;

export interface BrowserLoginDependencies {
  logins: BrowserLoginStore;
  queue: BrowserLoginQueue;
  events: BrowserLoginEvents;
  /** Seals with the session keyring (SESSION_KEKS); only the browser worker opens it. */
  sealer: SecretSealer;
  aad: BrowserLoginAad;
  /** Whether the X browser runs in the workspace. */
  gate: Pick<XBrowserGate, 'allows'>;
  unitOfWork: ChannelUnitOfWork;
  clock: Clock;
  ids: IdGenerator;
}

type LoginDeps = Pick<BrowserLoginDependencies, 'logins' | 'events' | 'clock'>;

const isOpen = (login: BrowserLogin): boolean => OPEN_BROWSER_LOGIN_STATUSES.includes(login.status);

async function changed(deps: LoginDeps, login: BrowserLogin | null): Promise<BrowserLogin | null> {
  if (login) {
    await deps.events.changed(login);
  }
  return login;
}

/** An open login past its time ends as TIMEOUT; the browser worker gives up on it then as well. */
async function settled(deps: LoginDeps, login: BrowserLogin): Promise<BrowserLogin> {
  if (!isOpen(login) || login.expiresAt > deps.clock.now()) {
    return login;
  }
  const ended = await changed(
    deps,
    await deps.logins.transition(login.id, OPEN_BROWSER_LOGIN_STATUSES, {
      status: 'FAILED',
      failure: 'TIMEOUT',
    }),
  );
  return ended ?? (await deps.logins.find(login.id)) ?? login;
}

/** The login of the actor; the logins of others count as unknown. */
async function ownLogin(deps: LoginDeps, actor: ContentActor, loginId: string): Promise<BrowserLogin> {
  const login = await deps.logins.find(loginId);
  if (login?.workspaceId !== actor.workspaceId || login.userId !== actor.userId) {
    throw new BrowserLoginNotFoundError();
  }
  return settled(deps, login);
}

interface LoginReport {
  organizationId: string;
  workspaceId: string;
  loginSessionId: string;
}

/** The open login a report of the browser worker names, or null. */
async function reportedLogin(deps: LoginDeps, report: LoginReport): Promise<BrowserLogin | null> {
  const found = await deps.logins.find(report.loginSessionId);
  if (found?.organizationId !== report.organizationId || found.workspaceId !== report.workspaceId) {
    return null;
  }
  const login = await settled(deps, found);
  return isOpen(login) ? login : null;
}

export interface StartBrowserLoginInput {
  actor: ContentActor;
  username: string;
  password: string;
  /** The language the browser worker opens X in. */
  locale: 'de' | 'en';
  /** The account to connect again; the same X user has to sign in. */
  reconnectAccountId: string | null;
}

export class StartBrowserLogin {
  constructor(private readonly deps: BrowserLoginDependencies) {}

  async execute(input: StartBrowserLoginInput): Promise<BrowserLogin> {
    const { actor } = input;
    assertCanManageChannels(actor);
    const { deps } = this;
    const { organizationId, workspaceId } = actor;
    if (!(await deps.gate.allows({ organizationId, workspaceId }))) {
      throw new XBrowserUnavailableError();
    }
    const { reconnectAccountId } = input;
    if (reconnectAccountId !== null) {
      const account = await deps.unitOfWork.run(channelScopeOf(actor), (store) =>
        store.accounts.find(workspaceId, reconnectAccountId),
      );
      if (account?.platform !== 'X' || account.disconnectedAt !== null) {
        throw new SocialAccountNotFoundError();
      }
    }
    const now = deps.clock.now();
    if ((await deps.logins.countStart(workspaceId, now)) > BROWSER_LOGINS_PER_HOUR) {
      throw new TooManyBrowserLoginsError();
    }

    const id = deps.ids.newId();
    const credentialsSealed = await deps.sealer.seal(
      JSON.stringify({ username: input.username, password: input.password }),
      deps.aad(workspaceId, id, 'credentials'),
    );
    const login: BrowserLogin = {
      id,
      organizationId,
      workspaceId,
      userId: actor.userId,
      status: 'STARTING',
      failure: null,
      accountId: null,
      reconnectAccountId,
      locale: input.locale,
      startedAt: now,
      expiresAt: new Date(now.getTime() + BROWSER_LOGIN_TTL_MS),
    };
    await deps.logins.create(login);
    await deps.queue.start({
      commandId: deps.ids.newId(),
      loginSessionId: id,
      organizationId,
      workspaceId,
      locale: input.locale,
      deadline: new Date(now.getTime() + BROWSER_LOGIN_START_WINDOW_MS),
      expiresAt: login.expiresAt,
      credentialsSealed,
    });
    return login;
  }
}

export class GetBrowserLogin {
  constructor(private readonly deps: LoginDeps) {}

  execute(actor: ContentActor, loginId: string): Promise<BrowserLogin> {
    assertCanManageChannels(actor);
    return ownLogin(this.deps, actor, loginId);
  }
}

export interface SubmitBrowserLoginCodeInput {
  actor: ContentActor;
  loginId: string;
  code: string;
}

export class SubmitBrowserLoginCode {
  constructor(
    private readonly deps: Pick<BrowserLoginDependencies, 'logins' | 'events' | 'sealer' | 'aad' | 'clock'>,
  ) {}

  async execute(input: SubmitBrowserLoginCodeInput): Promise<BrowserLogin> {
    assertCanManageChannels(input.actor);
    const { deps } = this;
    const login = await ownLogin(deps, input.actor, input.loginId);
    if (login.status !== 'AWAITING_2FA') {
      throw new BrowserLoginNotAwaitingCodeError();
    }
    const sealed = await deps.sealer.seal(input.code, deps.aad(login.workspaceId, login.id, 'code'));
    // The step changes first, so a second code for the same question is refused.
    const verifying = await deps.logins.transition(login.id, ['AWAITING_2FA'], { status: 'VERIFYING' });
    if (!verifying) {
      throw new BrowserLoginNotAwaitingCodeError();
    }
    await deps.logins.pushCode(login.id, sealed);
    await deps.events.changed(verifying);
    return verifying;
  }
}

/** A step of the browser worker short of the end: X asks for a code, or the login failed. */
export type BrowserLoginStep = { kind: 'awaiting_code' } | { kind: 'failed'; failure: BrowserLoginFailure };

export interface RecordBrowserLoginStepInput extends LoginReport {
  step: BrowserLoginStep;
}

export class RecordBrowserLoginStep {
  constructor(private readonly deps: LoginDeps) {}

  /** False when the login is unknown, of another workspace, or ended already. */
  async execute(input: RecordBrowserLoginStepInput): Promise<boolean> {
    const { deps } = this;
    const login = await reportedLogin(deps, input);
    if (!login) {
      return false;
    }
    const { step } = input;
    const next =
      step.kind === 'awaiting_code'
        ? await deps.logins.transition(login.id, ['STARTING', 'VERIFYING'], { status: 'AWAITING_2FA' })
        : await deps.logins.transition(login.id, OPEN_BROWSER_LOGIN_STATUSES, {
            status: 'FAILED',
            failure: step.failure,
          });
    return (await changed(deps, next)) !== null;
  }
}

export interface CompleteBrowserLoginInput extends LoginReport {
  /** The X user who signed in. */
  user: { id: string; handle: string; name: string; avatarUrl: string | null };
  /** The storage state, sealed by the browser worker for the workspace and the X user. */
  sessionSealed: Uint8Array;
}

export type BrowserLoginCompletion =
  | { status: 'connected'; connectionId: string; accountId: string }
  | { status: 'account_mismatch' }
  | { status: 'ignored' };

export class CompleteBrowserLogin {
  constructor(
    private readonly deps: Pick<
      BrowserLoginDependencies,
      'logins' | 'events' | 'unitOfWork' | 'clock' | 'ids'
    >,
  ) {}

  async execute(input: CompleteBrowserLoginInput): Promise<BrowserLoginCompletion> {
    const { deps } = this;
    const login = await reportedLogin(deps, input);
    if (!login) {
      return { status: 'ignored' };
    }
    const { workspaceId, organizationId } = login;
    const { user } = input;
    const name = user.name === '' ? user.handle : user.name;
    const scope = { userId: login.userId, organizationId, workspaceId };

    const connected = await deps.unitOfWork.run(scope, async (store) => {
      if (login.reconnectAccountId !== null) {
        const account = await store.accounts.find(workspaceId, login.reconnectAccountId);
        if (account && account.externalId !== user.id) {
          return null;
        }
      }
      const existing = await store.connections.findByExternalUser(workspaceId, 'X', 'BROWSER', user.id);
      const connectionId = existing?.id ?? deps.ids.newId();
      const grant: ConnectionGrant = {
        displayName: name,
        accessTokenSealed: null,
        refreshTokenSealed: null,
        sessionSealed: input.sessionSealed,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scopes: [],
        connectedById: login.userId,
        grantedAt: deps.clock.now(),
      };
      if (existing) {
        await store.connections.replaceGrant(workspaceId, connectionId, grant);
      } else {
        await store.connections.insert({
          id: connectionId,
          workspaceId,
          platform: 'X',
          method: 'BROWSER',
          externalUserId: user.id,
          ...grant,
        });
      }
      const [known] = await store.accounts.findByExternalIds(workspaceId, 'X', [user.id]);
      const accountId = known?.id ?? deps.ids.newId();
      await store.accounts.upsert({
        id: accountId,
        workspaceId,
        connectionId,
        platform: 'X',
        type: 'PROFILE',
        externalId: user.id,
        name,
        handle: user.handle,
        avatarUrl: user.avatarUrl,
        accessTokenSealed: null,
        connectedById: login.userId,
        // The browser worker opens X in this language for the account.
        settings: { locale: login.locale },
      });
      await store.audit.record({
        organizationId,
        workspaceId,
        action: existing ? 'channel.reconnect' : 'channel.connect',
        targetType: 'SocialConnection',
        targetId: connectionId,
        metadata: { platform: 'X', method: 'BROWSER', accounts: 1 },
      });
      return { connectionId, accountId };
    });

    if (!connected) {
      await changed(
        deps,
        await deps.logins.transition(login.id, OPEN_BROWSER_LOGIN_STATUSES, {
          status: 'FAILED',
          failure: 'ACCOUNT_MISMATCH',
        }),
      );
      return { status: 'account_mismatch' };
    }
    await changed(
      deps,
      await deps.logins.transition(login.id, OPEN_BROWSER_LOGIN_STATUSES, {
        status: 'SUCCEEDED',
        accountId: connected.accountId,
      }),
    );
    return { status: 'connected', ...connected };
  }
}
