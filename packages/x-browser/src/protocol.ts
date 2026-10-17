import { z } from 'zod';

// The protocol between the platform and the browser worker of X (architecture 4.3 and 7.4,
// guide step 6.2): the commands on the queue "xb-commands", their outcomes (the return value of
// the job, awaited by the caller) and the reports on "xb-results", which nobody awaits and the
// role "publisher" processes. It lives here, with zod as its only dependency, so the browser
// worker needs neither the database nor the rest of the platform. Commands carry what the
// browser needs: the sealed session (opened only in the browser worker), the text and signed
// media URLs. Nothing in here is plaintext secret.

export const XB_COMMANDS_QUEUE = 'xb-commands';
export const XB_RESULTS_QUEUE = 'xb-results';
/** The job name of every report on xb-results. */
export const XB_REPORT = 'xb.result';

export const XB_OPERATIONS = [
  'publish',
  'reconcile',
  'metrics',
  'account-metrics',
  'delete',
  'verify-session',
  'login.start',
  'canary',
] as const;
export type XbOperation = (typeof XB_OPERATIONS)[number];

/** The job name of a command, for example xb.publish. */
export const xbCommandName = (operation: XbOperation): `xb.${XbOperation}` => `xb.${operation}`;

export const xbOperationOf = (name: string): XbOperation | null => {
  const operation = name.startsWith('xb.') ? name.slice(3) : '';
  return (XB_OPERATIONS as readonly string[]).includes(operation) ? (operation as XbOperation) : null;
};

/** A sealed envelope (packages/crypto) as base64; a storage state of X fits easily. */
export const sealedSchema = z.base64().min(1).max(1_500_000);
/** The numeric id of an X user or post. */
export const xIdSchema = z.string().regex(/^\d{1,20}$/);
/** A handle without the @. */
export const xHandleSchema = z.string().regex(/^\w{1,15}$/);
export const xbLocaleSchema = z.enum(['de', 'en']);

/** The AAD of the session of a browser connection: its workspace and X user, the natural key of the connection. */
export const xbSessionAad = (workspaceId: string, externalUserId: string): string =>
  `${workspaceId}:x-browser.${externalUserId}:session`;

/** The AAD of what a login carries: the credentials once, then each code of the two-factor login. */
export const xbLoginAad = (
  workspaceId: string,
  loginSessionId: string,
  field: 'credentials' | 'code',
): string => `${workspaceId}:xb-login.${loginSessionId}:${field}`;

/** The credentials of a login, as JSON inside their envelope. */
export const xbCredentialsSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(256),
});
export type XbCredentials = z.infer<typeof xbCredentialsSchema>;

/** The account of a command and the session that reaches it. */
const target = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  connectionId: z.uuid(),
  accountId: z.uuid(),
  externalUserId: xIdSchema,
  handle: xHandleSchema.nullable(),
  locale: xbLocaleSchema,
  session: sealedSchema,
});
export type XbTarget = z.infer<typeof target>;

const command = z.object({
  /** Unique per call; part of the job id and of the logs. */
  commandId: z.uuid(),
  /** The browser worker does not start a command after this; its caller stopped waiting. */
  deadline: z.iso.datetime(),
});

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export const xbCommandSchemas = {
  publish: command.extend({
    target,
    text: z.string().min(1).max(25_000),
    media: z
      .array(
        z.object({ url: z.url(), mimeType: z.enum(MEDIA_TYPES), altText: z.string().max(1_000).nullable() }),
      )
      .max(4),
  }),
  reconcile: command.extend({ target, text: z.string().min(1).max(25_000), since: z.iso.datetime() }),
  metrics: command.extend({ target, externalPostIds: z.array(xIdSchema).min(1).max(10) }),
  'account-metrics': command.extend({ target }),
  delete: command.extend({ target, externalPostId: xIdSchema }),
  'verify-session': command.extend({ target }),
  'login.start': command.extend({
    organizationId: z.uuid(),
    workspaceId: z.uuid(),
    loginSessionId: z.uuid(),
    locale: xbLocaleSchema,
    credentials: sealedSchema,
  }),
  canary: command.extend({ target }),
} as const satisfies Record<XbOperation, z.ZodType>;

export type XbCommand<O extends XbOperation> = z.output<(typeof xbCommandSchemas)[O]>;

export const parseXbCommand = <O extends XbOperation>(operation: O, data: unknown): XbCommand<O> =>
  xbCommandSchemas[operation].parse(data) as XbCommand<O>;

/**
 * Why a command failed, mostly codes of the error taxonomy (architecture 4.1). EXPIRED: started
 * after its deadline; UNAVAILABLE: the kill switch is on; both sent nothing.
 */
export const XB_ERROR_CODES = [
  'AUTH_EXPIRED',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'RATE_LIMITED',
  'VALIDATION_REJECTED',
  'DUPLICATE',
  'TRANSIENT',
  'OUTCOME_UNKNOWN',
  'EXPIRED',
  'UNAVAILABLE',
] as const;
export type XbErrorCode = (typeof XB_ERROR_CODES)[number];

export const xbFailureSchema = z.object({
  code: z.enum(XB_ERROR_CODES),
  message: z.string().max(500),
  retryAfterMs: z.number().int().positive().optional(),
});
export type XbFailure = z.infer<typeof xbFailureSchema>;

/** The counters of a post as the web app of X reports them; null where it reports nothing. */
export const xPostCountsSchema = z.object({
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  replies: z.number().int().nonnegative().nullable(),
  reposts: z.number().int().nonnegative().nullable(),
  quotes: z.number().int().nonnegative().nullable(),
  bookmarks: z.number().int().nonnegative().nullable(),
});
export type XPostCounts = z.infer<typeof xPostCountsSchema>;

export const xUserSchema = z.object({
  id: xIdSchema,
  handle: xHandleSchema,
  name: z.string().max(100),
  avatarUrl: z.url().nullable(),
});
export type XUser = z.infer<typeof xUserSchema>;

const postRef = z.object({ externalPostId: xIdSchema, externalUrl: z.url(), publishedAt: z.iso.datetime() });

const outcome = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: xbFailureSchema }),
  ]);

export const xbOutcomeSchemas = {
  publish: outcome(postRef),
  reconcile: outcome(z.object({ found: postRef.nullable() })),
  metrics: outcome(
    z.object({
      items: z.array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('metrics'),
            externalPostId: xIdSchema,
            counts: xPostCountsSchema,
            /** The post as the web app of X sent it, kept with the snapshot. */
            raw: z.unknown(),
          }),
          z.object({ kind: z.literal('deleted'), externalPostId: xIdSchema }),
        ]),
      ),
    }),
  ),
  'account-metrics': outcome(
    z.object({ followers: z.number().int().nonnegative().nullable(), raw: z.unknown() }),
  ),
  delete: outcome(z.object({})),
  'verify-session': outcome(z.object({ user: xUserSchema })),
  // The steps of a login travel as reports; nobody awaits its job.
  'login.start': outcome(z.object({})),
  canary: outcome(z.object({ missing: z.array(z.string().max(100)).max(50) })),
} as const satisfies Record<XbOperation, z.ZodType>;

export type XbOutcome<O extends XbOperation> = z.output<(typeof xbOutcomeSchemas)[O]>;

export const parseXbOutcome = <O extends XbOperation>(operation: O, data: unknown): XbOutcome<O> =>
  xbOutcomeSchemas[operation].parse(data) as XbOutcome<O>;

/** Why a login ended without a connection; mirrors XB_LOGIN_FAILURES of @smp/contracts. */
export const XB_LOGIN_FAILURE_CODES = [
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'TIMEOUT',
  'ACCOUNT_MISMATCH',
  'UNAVAILABLE',
  'TRANSIENT',
] as const;
export type XbLoginFailureCode = (typeof XB_LOGIN_FAILURE_CODES)[number];

/** The flows of the browser, for the drift reports. */
export const XB_FLOWS = [
  'login',
  'verify-session',
  'publish',
  'reconcile',
  'metrics',
  'account-metrics',
  'delete',
  'canary',
] as const;
export type XbFlow = (typeof XB_FLOWS)[number];

const login = { loginSessionId: z.uuid(), organizationId: z.uuid(), workspaceId: z.uuid() };

export const xbReportSchema = z.discriminatedUnion('kind', [
  /** The storage state after a task, sealed again; the role "publisher" stores it. */
  z.object({
    kind: z.literal('session.updated'),
    organizationId: z.uuid(),
    workspaceId: z.uuid(),
    connectionId: z.uuid(),
    externalUserId: xIdSchema,
    session: sealedSchema,
  }),
  /** A selector or an answer of X that the map no longer matches; the breaker counts them. */
  z.object({
    kind: z.literal('drift'),
    flow: z.enum(XB_FLOWS),
    selector: z.string().max(100),
    selectorsVersion: z.string().max(20),
  }),
  z.object({ kind: z.literal('login.status'), ...login, status: z.enum(['AWAITING_2FA']) }),
  z.object({ kind: z.literal('login.succeeded'), ...login, user: xUserSchema, session: sealedSchema }),
  z.object({ kind: z.literal('login.failed'), ...login, failure: z.enum(XB_LOGIN_FAILURE_CODES) }),
  z.object({
    kind: z.literal('canary'),
    ok: z.boolean(),
    missing: z.array(z.string().max(100)).max(50),
    selectorsVersion: z.string().max(20),
  }),
]);
export type XbReport = z.infer<typeof xbReportSchema>;

export const parseXbReport = (data: unknown): XbReport => xbReportSchema.parse(data);

/** Redis keys shared with the browser worker; its Redis user reaches these and the xb queues only. */
export const XB_KEYS = {
  /** Set while the kill switch is on; the browser worker refuses every command. */
  kill: 'xb:kill',
  /** One task per account at a time. */
  lock: (accountId: string): string => `xb:lock:${accountId}`,
  /** Set for two minutes after a post of the account. */
  spacing: (accountId: string): string => `xb:spacing:${accountId}`,
  /** The sealed codes of the two-factor login, pushed by the API, popped by the browser worker. */
  loginInput: (loginSessionId: string): string => `xb:login:${loginSessionId}:input`,
} as const;
