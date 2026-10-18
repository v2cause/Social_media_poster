import { describe, expect, it, vi } from 'vitest';

import { createBreachCheck } from './breached-passwords';

// Guide step 8.4 (ASVS 6.2.12): the range API of Have I Been Pwned with k-anonymity. The SHA-1 of
// "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.

const PREFIX = '5BAA6';
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';
const OTHER = '0018A45C4D1DEF81644B54AB7F969B88D65';

function setUp(answer: () => Promise<Response>) {
  const requests: { url: string; headers: Headers }[] = [];
  // The check calls fetch with the URL as a string.
  const fetchRange = vi.fn((url: string, init?: RequestInit) => {
    requests.push({ url, headers: new Headers(init?.headers) });
    return answer();
  });
  const warnings: { data: object; message: string }[] = [];
  const logger = { warn: (data: object, message: string) => warnings.push({ data, message }) };
  const check = createBreachCheck({
    baseUrl: 'https://range.example/',
    logger,
    fetch: fetchRange as typeof fetch,
  });
  return { check, requests, warnings };
}

const answer =
  (body: string, status = 200) =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe('the breach check', () => {
  it('sends only the first five characters of the hash and finds the rest in the answer', async () => {
    const { check, requests } = setUp(answer(`${OTHER}:2\r\n${SUFFIX}:10434004\r\n`));

    await expect(check('password')).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://range.example/range/${PREFIX}`);
    expect(requests[0]?.headers.get('add-padding')).toBe('true');
    expect(requests[0]?.url).not.toContain(SUFFIX);
  });

  it('lets a password pass that is not in the answer or only padding there', async () => {
    await expect(setUp(answer(`${OTHER}:2\r\n`)).check('password')).resolves.toBe(false);
    await expect(setUp(answer(`${SUFFIX.toLowerCase()}:0\r\n`)).check('password')).resolves.toBe(false);
  });

  it('lets the password pass and warns when the service fails, answers oddly or is too slow', async () => {
    for (const failure of [
      answer('Service Unavailable', 503),
      answer('<html>maintenance</html>'),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    ]) {
      const { check, warnings } = setUp(failure);
      await expect(check('password')).resolves.toBe(false);
      expect(warnings.map((warning) => warning.message)).toEqual(['auth.breach_check_unavailable']);
      expect(JSON.stringify(warnings)).not.toContain('password');
    }
  });
});
