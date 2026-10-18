import { z } from 'zod';

import { localeSchema } from './locale';

// Requests and responses of the optional X browser (guide steps 6.1 and 6.4): its status in a
// workspace, switching it on with the risk acknowledgement, the interactive login and the
// switches of the platform admins. Passwords and codes only go in; nothing secret comes back.

const id = z.uuid();
const timestamp = z.iso.datetime();

/** Why the X browser cannot run in a workspace, in the order the settings explain them. */
export const X_BROWSER_BLOCKS = [
  'deployment',
  'kill_switch',
  'plan',
  'workspace',
  'acknowledgement',
] as const;
export const xBrowserBlockSchema = z.enum(X_BROWSER_BLOCKS);
export type XBrowserBlockDto = z.infer<typeof xBrowserBlockSchema>;

export const xBrowserStatusSchema = z.object({
  /** Every condition holds: accounts can be connected and used. */
  available: z.boolean(),
  /** The conditions that do not hold. */
  blocks: z.array(xBrowserBlockSchema),
  /** The workspace switched the X browser on. */
  enabled: z.boolean(),
  /** The version of the risk text that has to be acknowledged. */
  currentVersion: z.string(),
  /** The acknowledgement in force, also one of an older version of the text. */
  acknowledgement: z
    .object({
      version: z.string(),
      locale: localeSchema,
      acceptedAt: timestamp,
      /** Null when the user no longer exists. */
      acceptedBy: z.object({ id, name: z.string() }).nullable(),
    })
    .nullable(),
});
export type XBrowserStatusDto = z.infer<typeof xBrowserStatusSchema>;

/** Switches the X browser on: the version of the text the user read, the checkbox and the password. */
export const enableXBrowserSchema = z.object({
  version: z.string().min(1).max(40),
  locale: localeSchema,
  accepted: z.literal(true),
  password: z.string().min(1).max(256),
});
export type EnableXBrowserRequest = z.input<typeof enableXBrowserSchema>;

export const XB_LOGIN_STATUSES = ['STARTING', 'AWAITING_2FA', 'VERIFYING', 'SUCCEEDED', 'FAILED'] as const;
export const xbLoginStatusSchema = z.enum(XB_LOGIN_STATUSES);
export type XbLoginStatusDto = z.infer<typeof xbLoginStatusSchema>;

/** Why a login ended without a connection. The UI translates the code. */
export const XB_LOGIN_FAILURES = [
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'TIMEOUT',
  'ACCOUNT_MISMATCH',
  'PLAN_LIMIT_REACHED',
  'UNAVAILABLE',
  'TRANSIENT',
] as const;
export const xbLoginFailureSchema = z.enum(XB_LOGIN_FAILURES);
export type XbLoginFailureDto = z.infer<typeof xbLoginFailureSchema>;

export const startXbLoginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
  /** The language the browser worker opens X in, usually that of the interface. */
  locale: localeSchema,
  /** The account to connect again; the same X user has to sign in. */
  reconnectAccountId: id.optional(),
});
export type StartXbLoginRequest = z.input<typeof startXbLoginSchema>;

/** A code of the two-factor login: six digits from an app or a text message, or a backup code. */
export const xbLoginCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,12}$/),
});
export type XbLoginCodeRequest = z.input<typeof xbLoginCodeSchema>;

export const xbLoginSessionSchema = z.object({
  id,
  status: xbLoginStatusSchema,
  failure: xbLoginFailureSchema.nullable(),
  /** The connected account after SUCCEEDED. */
  accountId: id.nullable(),
  expiresAt: timestamp,
});
export type XbLoginSessionDto = z.infer<typeof xbLoginSessionSchema>;

/** The switches of the platform admins: the global kill switch and, until plans, the organizations. */
export const xBrowserAdminSchema = z.object({
  /** FEATURE_X_BROWSER_GLOBAL: the deployment runs the browser worker. */
  offered: z.boolean(),
  killSwitch: z.object({ active: z.boolean(), updatedAt: timestamp.nullable() }),
  /** The organizations allowed to use the X browser. */
  organizations: z.array(z.object({ id, name: z.string(), updatedAt: timestamp })),
});
export type XBrowserAdminDto = z.infer<typeof xBrowserAdminSchema>;

export const setKillSwitchSchema = z.object({ active: z.boolean() });
export type SetKillSwitchRequest = z.input<typeof setKillSwitchSchema>;

/** Allows the organization of a workspace; organizations have no slug of their own. */
export const allowXBrowserOrganizationSchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(63),
});
export type AllowXBrowserOrganizationRequest = z.input<typeof allowXBrowserOrganizationSchema>;

export const xBrowserOrganizationSchema = z.object({ id, name: z.string() });
export type XBrowserOrganizationDto = z.infer<typeof xBrowserOrganizationSchema>;
