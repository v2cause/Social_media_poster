import { PlatformHttpClient } from '../http/platform-http-client';
import { XApiAdapter } from './adapter';
import { resolveXConfig, type XAdapterConfig } from './x-config';

// The X API adapter (guide step 4.14): build it with createXAdapter and the OAuth 2.0 client of
// the developer app. The registry wraps it with the spend cap (src/spend-capped-adapter.ts).

/** Builds the X API adapter with its own HTTP client; throws when the configuration is invalid. */
export function createXAdapter(config: XAdapterConfig): XApiAdapter {
  const resolved = resolveXConfig(config);
  const http = new PlatformHttpClient({
    platform: 'X',
    fetch: resolved.fetch,
    ...(resolved.logger ? { logger: resolved.logger } : {}),
    ...(resolved.limiter ? { limiter: resolved.limiter } : {}),
  });
  return new XApiAdapter(resolved, http);
}

export { comparableText, X_METRICS_BATCH, X_RECONCILE_POSTS, XApiAdapter, xTextOf } from './adapter';
export { tokenSetOf, X_SCOPES, XOAuthConnector } from './connector';
export { MAP_VERSION as X_MAP_VERSION, normalizeXAccountMetrics, normalizeXPostMetrics } from './metrics-map';
export { altTextOf, isUploadableMimeType, XMediaUploader } from './media-upload';
export { X_API_BASE_URL, X_AUTHORIZE_URL, xAdapterConfigSchema, type XAdapterConfig } from './x-config';
export { containsUrl, postCreateOperation, X_COST_OPERATIONS } from './x-costs';
