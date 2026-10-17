// Brings the price list in Stripe in line with the catalog of @smp/billing (guide step 7.2): the
// meters of the usage billing, a product and price per plan and meter by lookup key, and the
// customer portal. It runs again without harm. Use a test key first; the amounts of the catalog
// are placeholders until the operators set the real ones.
//
// Run from the repository root after `pnpm build`: pnpm stripe:sync

import { createStripeClient, syncCatalog } from '@smp/billing';

async function main(): Promise<void> {
  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set. Put a key of the Stripe account into .env first.');
  }
  const apiBase = process.env['STRIPE_API_BASE'] || undefined;
  if (apiBase && !secretKey.startsWith('sk_test_') && !secretKey.startsWith('rk_test_')) {
    throw new Error('STRIPE_API_BASE takes test keys only.');
  }
  const report = await syncCatalog(createStripeClient({ secretKey, ...(apiBase ? { apiBase } : {}) }));
  for (const [label, entries] of Object.entries(report)) {
    process.stdout.write(`${label}: ${entries.length > 0 ? entries.join(', ') : '-'}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
