export const WORKER_ENV = Symbol('WORKER_ENV');
export const MAIL_PORT = Symbol('MAIL_PORT');
export const DELIVER_NOTIFICATION = Symbol('DELIVER_NOTIFICATION');
/** The token keyring that opens the sealed emails of the notify jobs (guide step 8.4). */
export const EMAIL_SEALER = Symbol('EMAIL_SEALER');
export const PROCESS_ASSET = Symbol('PROCESS_ASSET');
export const RENDER_ATTACHED_MEDIA = Symbol('RENDER_ATTACHED_MEDIA');
export const TICK_HANDLERS = Symbol('TICK_HANDLERS');
export const PUBLISH_PIPELINE = Symbol('PUBLISH_PIPELINE');
export const ANALYTICS_PIPELINE = Symbol('ANALYTICS_PIPELINE');
export const BILLING_PIPELINE = Symbol('BILLING_PIPELINE');
export const GDPR_PIPELINE = Symbol('GDPR_PIPELINE');
