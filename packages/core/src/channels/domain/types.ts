// The channels context (architecture 4 and 6.2): connections to the platforms and the accounts
// they publish to.

/** How a connection reaches its platform. */
export const CONNECTION_METHODS = ['API', 'BROWSER', 'MOCK'] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export const CONNECTION_STATUSES = ['ACTIVE', 'EXPIRING', 'NEEDS_REAUTH', 'PAUSED', 'REVOKED'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** A profile of a person, a company or Facebook page, an Instagram professional account. */
export const SOCIAL_ACCOUNT_TYPES = ['PROFILE', 'PAGE', 'BUSINESS'] as const;
export type SocialAccountType = (typeof SOCIAL_ACCOUNT_TYPES)[number];
