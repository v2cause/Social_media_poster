import type { Platform } from '@smp/platform-rules';
import { z } from 'zod';

import { platformSchema } from './content';

// Requests and responses of the channels API (guide step 4.5): the platforms on offer, the
// connected accounts, the start of the OAuth flow and the selection of the accounts after the
// consent. Tokens never appear here; they stay sealed on the server.

const id = z.uuid();
const timestamp = z.iso.datetime();

export const CONNECTION_METHODS = ['API', 'BROWSER', 'MOCK'] as const;
export const connectionMethodSchema = z.enum(CONNECTION_METHODS);
export type ConnectionMethodDto = z.infer<typeof connectionMethodSchema>;

export const CONNECTION_STATUSES = ['ACTIVE', 'EXPIRING', 'NEEDS_REAUTH', 'PAUSED', 'REVOKED'] as const;
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatusDto = z.infer<typeof connectionStatusSchema>;

/** A personal profile, a company or Facebook page, or an Instagram professional account. */
export const SOCIAL_ACCOUNT_TYPES = ['PROFILE', 'PAGE', 'BUSINESS'] as const;
export const socialAccountTypeSchema = z.enum(SOCIAL_ACCOUNT_TYPES);
export type SocialAccountTypeDto = z.infer<typeof socialAccountTypeSchema>;

/** The platform in the paths of the channels API and of the OAuth callback, for example "linkedin". */
export const PLATFORM_SLUGS = ['linkedin', 'instagram', 'facebook', 'x'] as const;
export type PlatformSlug = (typeof PLATFORM_SLUGS)[number];
export const platformSlugSchema = z.enum(PLATFORM_SLUGS);

export const platformOfSlug = (slug: PlatformSlug): Platform => slug.toUpperCase() as Platform;
export const slugOfPlatform = (platform: Platform): PlatformSlug => platform.toLowerCase() as PlatformSlug;

/** A platform that can be connected, with the method its new connections use. */
export const channelOptionSchema = z.object({
  platform: platformSchema,
  method: connectionMethodSchema,
});
export const channelOptionListSchema = z.object({ items: z.array(channelOptionSchema) });
export type ChannelOptionListDto = z.infer<typeof channelOptionListSchema>;

/** A connected account: a target to publish to. */
export const socialAccountSchema = z.object({
  id,
  connectionId: id,
  platform: platformSchema,
  method: connectionMethodSchema,
  type: socialAccountTypeSchema,
  name: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** The status of the connection behind the account. */
  status: connectionStatusSchema,
  /** When the access runs out; null when it does not expire. */
  accessExpiresAt: timestamp.nullable(),
  /** Scopes the connection asked for and did not get, for example the statistics. */
  missingScopes: z.array(z.string()),
  connectedAt: timestamp,
  /** The paid calls of the account so far in micro-USD (X); null where calls cost nothing. */
  costMicros: z.number().int().nonnegative().nullable(),
});
export type SocialAccountDto = z.infer<typeof socialAccountSchema>;
export const socialAccountListSchema = z.object({ items: z.array(socialAccountSchema) });
export type SocialAccountListDto = z.infer<typeof socialAccountListSchema>;

/** Where the browser goes for the consent of the platform. */
export const authorizationUrlSchema = z.object({ authorizationUrl: z.url() });
export type AuthorizationUrlDto = z.infer<typeof authorizationUrlSchema>;

/** The id of a pending connection: 32 random bytes as base64url. */
export const pendingConnectionIdSchema = z.string().regex(/^[\w-]{43}$/);

/** A target the consent reaches, offered for selection. */
export const connectableAccountSchema = z.object({
  externalId: z.string(),
  type: socialAccountTypeSchema,
  name: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** Already connected in this workspace; confirming it renews its access. */
  connected: z.boolean(),
});

/** The consent of a platform, parked for 15 minutes until the user picks the accounts. */
export const pendingConnectionSchema = z.object({
  id: pendingConnectionIdSchema,
  platform: platformSchema,
  method: connectionMethodSchema,
  /** The platform user who gave the consent. */
  displayName: z.string(),
  accounts: z.array(connectableAccountSchema),
  grantedScopes: z.array(z.string()),
  missingScopes: z.array(z.string()),
  /** The account the user reconnects; the page selects it in advance. */
  reconnectAccountId: id.nullable(),
  expiresAt: timestamp,
});
export type PendingConnectionDto = z.infer<typeof pendingConnectionSchema>;

export const confirmConnectionSchema = z.object({
  externalIds: z.array(z.string().min(1).max(200)).min(1).max(50),
});
export type ConfirmConnectionRequest = z.input<typeof confirmConnectionSchema>;

export const confirmedConnectionSchema = z.object({
  connectionId: id,
  accountIds: z.array(id),
});
export type ConfirmedConnectionDto = z.infer<typeof confirmedConnectionSchema>;

/**
 * Why the OAuth callback sent the browser back without a consent to choose from, in the query
 * parameter connect_error. The UI translates the code.
 */
export const CONNECT_FAILURES = [
  'STATE_INVALID',
  'USER_MISMATCH',
  'ACCESS_DENIED',
  'PROVIDER_ERROR',
  'EXCHANGE_FAILED',
  'CHANNEL_UNAVAILABLE',
] as const;
export const connectFailureSchema = z.enum(CONNECT_FAILURES);
export type ConnectFailure = z.infer<typeof connectFailureSchema>;
