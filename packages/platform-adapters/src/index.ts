// Social platform adapters (architecture 4): the HTTP client and rate limiter they share, the
// registry, and the adapters themselves (the mock adapter now; LinkedIn, Meta and X follow).

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
  PLATFORM_MODE_VARIABLES,
  PLATFORM_MODES,
  platformEnvSchema,
  platformModeOf,
  usesMockPlatform,
  type PlatformEnv,
  type PlatformMode,
} from './env';
export { operationPriceMicros, PLATFORM_OPERATION_PRICES_MICROS } from './prices';
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
export { BullBrowserLoginQueue } from './x-browser/login-queue';
export { RedisBrowserLoginStore } from './x-browser/login-store';
export { normalizeXBrowserPostMetrics, X_BROWSER_MAP_VERSION } from './x-browser/metrics-map';
export { XB_START_WINDOW_MS, XBrowserRemoteAdapter } from './x-browser/remote-adapter';
