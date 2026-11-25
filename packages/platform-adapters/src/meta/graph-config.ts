import { z } from 'zod';

// The settings of the Meta app that Facebook and Instagram share (guide step 4.13, architecture
// 4.1: pinned versions, META_GRAPH_VERSION=vNN.0). The app secret stays on the server: it signs
// every call (appsecret_proof) and the code exchange, and never reaches a log or an error.

/**
 * The pinned Graph API version. v27.0 is the latest version, introduced on 2026-11-04, available
 * until a date Meta has not announced yet ("TBD"). Checked 2026-11-25:
 * https://developers.facebook.com/docs/graph-api/changelog/
 */
export const DEFAULT_META_GRAPH_VERSION = 'v27.0';

/** The host of the Graph API for Facebook Pages and the Instagram API with Facebook Login. */
export const META_GRAPH_HOST = 'https://graph.facebook.com';

/** The host of the login dialog (manual login flow, checked 2026-11-25:
 * https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow). */
export const META_DIALOG_HOST = 'https://www.facebook.com';

const numericId = z.string().regex(/^\d{5,25}$/, 'expected a numeric Meta id');

export const metaAppConfigSchema = z.object({
  /** The Meta app id, at the top of the App Dashboard. */
  appId: numericId,
  /** The app secret (App settings > Basic). */
  appSecret: z.string().min(16).max(128),
  /** For example v27.0. */
  graphVersion: z
    .string()
    .regex(/^v\d{1,3}\.\d$/, 'expected a Graph API version like v27.0')
    .default(DEFAULT_META_GRAPH_VERSION),
});
export type MetaAppConfig = z.input<typeof metaAppConfigSchema>;
export type ResolvedMetaAppConfig = z.output<typeof metaAppConfigSchema>;

/**
 * The id of a Facebook Login for Business configuration, optional. With it the login dialog gets
 * config_id instead of scope: "although scope can still be included, we recommend that you do not
 * use it". Checked 2026-11-25:
 * https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business
 */
export const loginConfigIdSchema = numericId.optional();

export function resolveMetaAppConfig(config: MetaAppConfig): ResolvedMetaAppConfig {
  const parsed = metaAppConfigSchema.safeParse(config);
  if (!parsed.success) {
    // Only the paths of the broken fields: the values may hold the secret.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`The Meta app configuration is invalid (${fields}).`);
  }
  return parsed.data;
}
