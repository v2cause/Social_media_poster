import { expect } from '@playwright/test';
import { z } from 'zod';

// Reads emails from the Mailpit API of the local stack (guide step 1.9).

const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

const searchResult = z.object({ messages: z.array(z.object({ ID: z.string(), Subject: z.string() })) });
const message = z.object({ Subject: z.string(), Text: z.string() });

/** Waits for the newest email to an address and returns the first link that matches. */
export async function linkFromEmail(to: string, pattern: RegExp): Promise<{ subject: string; url: string }> {
  let found: { subject: string; url: string } | undefined;
  await expect
    .poll(
      async () => {
        const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const newest = searchResult.parse(await search.json()).messages[0];
        if (!newest) {
          return false;
        }
        const detail = message.parse(
          await (await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`)).json(),
        );
        const url = pattern.exec(detail.Text)?.[0];
        found = url ? { subject: detail.Subject, url } : undefined;
        return Boolean(found);
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
  if (!found) {
    throw new Error(`no matching link in the email to ${to}`);
  }
  return found;
}
