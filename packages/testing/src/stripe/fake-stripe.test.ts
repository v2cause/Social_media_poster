import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { FakeStripe, stripeSignature } from './fake-stripe';
import { decodeForm } from './form';
import { checkParams, endpointOf } from './params';

// The fake Stripe of the tests: the form encoding of the API, the parameters of the official spec
// and the signed webhooks.

const SECRET = 'whsec_test_secret';

describe('the form encoding of the Stripe API', () => {
  it('decodes nested objects and indexed arrays', () => {
    const body =
      'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&line_items[1][price]=price_2' +
      '&automatic_tax[enabled]=true&metadata[organizationId]=org-1&expand[]=a&expand[]=b';
    expect(decodeForm(body)).toEqual({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: '1' }, { price: 'price_2' }],
      automatic_tax: { enabled: 'true' },
      metadata: { organizationId: 'org-1' },
      expand: ['a', 'b'],
    });
  });
});

describe('the parameters of the official spec', () => {
  it('finds the endpoint of a path and names unknown or missing parameters as Stripe does', () => {
    expect(endpointOf('GET', '/v1/subscriptions/sub_123')).toBe(
      'GET /v1/subscriptions/{subscription_exposed_id}',
    );
    expect(endpointOf('DELETE', '/v1/subscriptions/sub_123')).toBeNull();
    expect(endpointOf('DELETE', '/v1/customers/cus_123')).toBe('DELETE /v1/customers/{customer}');
    expect(checkParams('DELETE /v1/customers/{customer}', { force: 'true' })).toBe(
      'Received unknown parameter: force',
    );
    const template = 'POST /v1/checkout/sessions';
    expect(checkParams(template, { mode: 'subscription', automatic_tax: { enabled: 'true' } })).toBeNull();
    expect(checkParams(template, { mode: 'subscription', automatic_taxes: 'true' })).toBe(
      'Received unknown parameter: automatic_taxes',
    );
    expect(checkParams(template, { line_items: [{ price: 'p', quantiti: '1' }] })).toBe(
      'Received unknown parameter: line_items[0][quantiti]',
    );
    expect(checkParams('POST /v1/billing/meter_events', { event_name: 'x' })).toBe(
      'Missing required param: payload.',
    );
  });
});

describe('the fake Stripe', () => {
  let fake: FakeStripe | undefined;

  afterEach(async () => {
    await fake?.close();
  });

  const post = (path: string, body: string, key = 'sk_test_fake') =>
    fetch(`${fake?.url ?? ''}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('accepts test keys only and refuses unknown parameters', async () => {
    fake = await FakeStripe.start({ webhookSecret: SECRET });

    expect((await post('/v1/customers', 'email=a%40example.test', 'sk_live_real')).status).toBe(401);
    const refused = await post('/v1/customers', 'emial=a%40example.test');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: 'Received unknown parameter: emial' },
    });
    const created = await post('/v1/customers', 'email=a%40example.test&metadata[organizationId]=org-1');
    expect(await created.json()).toMatchObject({ object: 'customer', email: 'a@example.test' });
  });

  it('deletes a customer for good and ends its subscriptions', async () => {
    fake = await FakeStripe.start({ webhookSecret: SECRET });
    const customer = (await (await post('/v1/customers', 'email=b%40example.test')).json()) as { id: string };
    fake.subscriptions.set('sub_1', {
      id: 'sub_1',
      object: 'subscription',
      customer: customer.id,
      status: 'active',
    });
    const remove = () =>
      fetch(`${fake?.url ?? ''}/v1/customers/${customer.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer sk_test_fake' },
      });

    const deleted = await remove();

    expect(await deleted.json()).toEqual({ id: customer.id, object: 'customer', deleted: true });
    expect(fake.customers.has(customer.id)).toBe(false);
    expect(fake.subscriptions.get('sub_1')).toMatchObject({ status: 'canceled' });
    const again = await remove();
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: 'resource_missing' } });
  });

  it('signs its webhooks the way the SDK checks them', async () => {
    const received: { signature: string; body: string }[] = [];
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        received.push({
          signature: String(request.headers['stripe-signature']),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = receiver.address() as AddressInfo;
      fake = await FakeStripe.start({
        webhookSecret: SECRET,
        webhookUrl: `http://127.0.0.1:${String(port)}/`,
      });

      await expect(fake.send('invoice.paid', { id: 'in_1', object: 'invoice' })).resolves.toBe(200);

      const [delivery] = received;
      const [timestamp, signature] = (delivery?.signature ?? '')
        .split(',')
        .map((part) => part.slice(part.indexOf('=') + 1));
      const expected = createHmac('sha256', SECRET)
        .update(`${String(timestamp)}.${delivery?.body ?? ''}`)
        .digest('hex');
      expect(signature).toBe(expected);
      expect(stripeSignature('{}', SECRET, 1)).toBe(
        `t=1,v1=${createHmac('sha256', SECRET).update('1.{}').digest('hex')}`,
      );
      expect(JSON.parse(delivery?.body ?? '{}')).toMatchObject({
        type: 'invoice.paid',
        data: { object: { id: 'in_1' } },
      });
    } finally {
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => {
        receiver.close(() => {
          resolve();
        });
      });
    }
  });
});
