// The prices of paid platform calls in micro-USD (1 USD = 1000000). Only X charges per call
// (pay-per-use since 2026-02-06, architecture "Faktenlage"). Checked on 2026-11-25 against
// https://docs.x.com/x-api/getting-started/pricing and the changelog entry of 2026-04-16 (guide
// step 4.14). The pricing page names no price for media uploads, and none that clearly covers
// deleting a post: x.post_delete takes the higher of the two candidates ($0.010 and $0.005).

export const PLATFORM_OPERATION_PRICES_MICROS: Readonly<Record<string, number>> = {
  'x.post_create': 15_000,
  'x.post_create_with_url': 200_000,
  /** Per post returned. */
  'x.post_read': 5_000,
  /** Per post of the own timeline, when the account owns the app. */
  'x.owned_post_read': 1_000,
  'x.user_read': 10_000,
  /** The alt text of one image. */
  'x.media_metadata': 5_000,
  'x.post_delete': 10_000,
};

/** The price of one unit of an operation; null for an operation without a known price. */
export const operationPriceMicros = (operation: string): number | null =>
  PLATFORM_OPERATION_PRICES_MICROS[operation] ?? null;
