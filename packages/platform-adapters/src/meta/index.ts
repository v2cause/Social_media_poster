// The Meta adapters (guide step 4.13): Facebook Pages and Instagram professional accounts through
// one Meta app with Facebook Login and the pinned Graph API version.

export { createFacebookAdapter, FacebookAdapter, type FacebookAdapterConfig } from './facebook-adapter';
export { FacebookConnector, type FacebookConnectorOptions } from './facebook-connector';
export {
  FACEBOOK_MAP_VERSION,
  normalizeFacebookAccountMetrics,
  normalizeFacebookPostMetrics,
} from './facebook-metrics-map';
export { DEFAULT_META_GRAPH_VERSION, metaAppConfigSchema, type MetaAppConfig } from './graph-config';
export {
  CONTAINER_MAX_WAIT_MS,
  CONTAINER_POLL_DELAYS_MS,
  createInstagramAdapter,
  InstagramAdapter,
  type InstagramAdapterConfig,
} from './instagram-adapter';
export { InstagramConnector, type InstagramConnectorOptions } from './instagram-connector';
export {
  INSTAGRAM_MAP_VERSION,
  normalizeInstagramAccountMetrics,
  normalizeInstagramPostMetrics,
} from './instagram-metrics-map';
export { FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from './meta-scopes';
export { isPublicHost, publicMediaUrl } from './public-media-url';
