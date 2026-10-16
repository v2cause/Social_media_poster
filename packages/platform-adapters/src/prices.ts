// The prices of paid platform calls in micro-USD (1 USD = 1000000). Only X charges per call
// (pay-per-use since February 2026, architecture "Faktenlage"). The numbers come from secondary
// sources and are checked against the docs of X with its adapter (guide step 4.14).

export const PLATFORM_OPERATION_PRICES_MICROS: Readonly<Record<string, number>> = {
  'x.post_create': 15_000,
  'x.post_create_with_link': 200_000,
  'x.post_read': 5_000,
};

/** The price of one unit of an operation; null for an operation without a known price. */
export const operationPriceMicros = (operation: string): number | null =>
  PLATFORM_OPERATION_PRICES_MICROS[operation] ?? null;
