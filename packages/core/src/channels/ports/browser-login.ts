// The interactive login of X without the API (guide step 6.4, architecture 4.3). Its state lives
// for five minutes outside the database (Redis); the credentials and the codes of the two-factor
// login only ever travel sealed with the session keyring, to the browser worker, which alone
// opens them. Implemented in @smp/platform-adapters.

export const BROWSER_LOGIN_STATUSES = [
  'STARTING',
  'AWAITING_2FA',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type BrowserLoginStatus = (typeof BROWSER_LOGIN_STATUSES)[number];

export const BROWSER_LOGIN_FAILURES = [
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'TIMEOUT',
  'ACCOUNT_MISMATCH',
  'UNAVAILABLE',
  'TRANSIENT',
] as const;
export type BrowserLoginFailure = (typeof BROWSER_LOGIN_FAILURES)[number];

/** The statuses a login can still leave. */
export const OPEN_BROWSER_LOGIN_STATUSES: readonly BrowserLoginStatus[] = [
  'STARTING',
  'AWAITING_2FA',
  'VERIFYING',
];

export interface BrowserLogin {
  id: string;
  organizationId: string;
  workspaceId: string;
  /** The user who started it; only they see it and send its codes. */
  userId: string;
  status: BrowserLoginStatus;
  failure: BrowserLoginFailure | null;
  /** The connected account after SUCCEEDED. */
  accountId: string | null;
  /** The account to connect again; the same X user has to sign in. */
  reconnectAccountId: string | null;
  locale: 'de' | 'en';
  startedAt: Date;
  expiresAt: Date;
}

export interface BrowserLoginStore {
  /** Stores a new login until a while after it expires. */
  create(login: BrowserLogin): Promise<void>;
  find(id: string): Promise<BrowserLogin | null>;
  /** Changes the status if it is one of `from`; returns the changed login, or null when it did not change. */
  transition(
    id: string,
    from: readonly BrowserLoginStatus[],
    change: { status: BrowserLoginStatus; failure?: BrowserLoginFailure; accountId?: string },
  ): Promise<BrowserLogin | null>;
  /** Hands a sealed code of the two-factor login to the browser worker. */
  pushCode(id: string, sealed: Uint8Array): Promise<void>;
  /** Counts a start of the workspace in the hour of `at`; returns the count of that hour with it. */
  countStart(workspaceId: string, at: Date): Promise<number>;
}

/** The command that starts a login in the browser worker. */
export interface BrowserLoginCommand {
  commandId: string;
  loginSessionId: string;
  organizationId: string;
  workspaceId: string;
  locale: 'de' | 'en';
  /** The browser worker does not start the login after this. */
  deadline: Date;
  /** The login ends at this time at the latest. */
  expiresAt: Date;
  credentialsSealed: Uint8Array;
}

export interface BrowserLoginQueue {
  start(command: BrowserLoginCommand): Promise<void>;
}

/** Tells the browser of the user who started the login about its new status. */
export interface BrowserLoginEvents {
  changed(login: BrowserLogin): Promise<void>;
}

/** The AAD of what a login carries, as the browser worker opens it (protocol of @smp/x-browser). */
export type BrowserLoginAad = (
  workspaceId: string,
  loginSessionId: string,
  field: 'credentials' | 'code',
) => string;
