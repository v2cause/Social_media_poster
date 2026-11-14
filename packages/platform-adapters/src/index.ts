// Social platform adapters (architecture 4): the HTTP client and rate limiter they share, the
// registry, and the adapters themselves: LinkedIn, Facebook, Instagram and the X API (guide steps
// 4.12 to 4.14), the mock adapter and the browser adapter of X.

export { DEFAULT_RATE_LIMIT_WAIT_MS, platformErrorOf } from './http/errors';
export {
  PlatformHttpClient,
  type ErrorResponse,
  type HttpBody,
  type HttpMethod,
  type PlatformHttpClientOptions,
  type PlatformRequest,
  type PlatformResponse,
} from './http/platform-http-client';
export { retryAfterMsOf } from './http/rate-headers';
export {
  DEFAULT_RATE_LIMITS,
  PlatformRateLimiter,
  type BucketLimit,
  type PlatformRateLimits,
  type RateLimitScope,
} from './rate-limit/platform-rate-limiter';
export { AdapterNotAvailableError, AdapterRegistry, type BrowserGate } from './registry';
export { createAdapterRegistry, PlatformConfigError, type AdapterRegistryOptions } from './create-registry';
export {
  checkPlatformEnv,
  PLATFORM_MODE_VARIABLES,
  PLATFORM_MODES,
  platformEnvSchema,
  platformModeOf,
  usesMockPlatform,
  type PlatformEnv,
  type PlatformMode,
} from './env';
export { liveAdapters, type LiveAdapterBuilders } from './live/live-adapters';
export type { LiveAdapterDeps } from './live/live-support';
export { LinkedInAdapter } from './linkedin/linkedin-adapter';
export { FacebookAdapter } from './meta/facebook-adapter';
export { InstagramAdapter } from './meta/instagram-adapter';
export { verifyMetaSignedRequest, type MetaSignedRequest } from './meta/signed-request';
export { XApiAdapter } from './x/x-adapter';
export { operationPriceMicros, PLATFORM_OPERATION_PRICES_MICROS } from './prices';
export { isSpendCapped, spendCappedAdapter } from './spend-capped-adapter';
export { PLATFORM_SCOPES } from './scopes';
export {
  decodeMockCode,
  encodeMockCode,
  isPlatform,
  pkceChallengeOf,
  type MockAuthorizationCode,
} from './mock/mock-code';
export {
  MOCK_CODE_TTL_MS,
  MOCK_PARTIAL_GRANT_DROPS,
  MOCK_USER,
  mockConsentLinks,
  type MockConsentLinks,
  type MockConsentRequest,
} from './mock/mock-consent';
export { MockOAuthConnector } from './mock/mock-oauth-connector';
export {
  MOCK_FAIL_MODES,
  mockAccountSettingsSchema,
  MockPlatformAdapter,
  type MockAccountSettings,
  type MockFailMode,
} from './mock/mock-platform-adapter';
export {
  InMemoryMockPlatformStore,
  RedisMockPlatformStore,
  type MockPlatformStore,
  type MockPost,
} from './mock/mock-platform-store';
export { RedisXBrowserKillSignal } from './x-browser/kill-signal';
export {
  BullXbCommandBus,
  CommandNotAnsweredError,
  type SendOptions,
  type XbCommandBus,
} from './x-browser/command-bus';
export { RedisSelectorDriftCounter } from './x-browser/drift-counter';
export { BullBrowserLoginQueue } from './x-browser/login-queue';
export { RedisBrowserLoginStore } from './x-browser/login-store';
export { normalizeXBrowserPostMetrics, X_BROWSER_MAP_VERSION } from './x-browser/metrics-map';
export { XB_START_WINDOW_MS, XBrowserRemoteAdapter, xbWaitMs } from './x-browser/remote-adapter';
