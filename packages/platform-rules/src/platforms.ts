/** The platforms a variant can target. Same values as the Platform enum of the database. */
export const PLATFORMS = ['LINKEDIN', 'INSTAGRAM', 'FACEBOOK', 'X'] as const;
export type Platform = (typeof PLATFORMS)[number];
