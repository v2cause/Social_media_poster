import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { decodeForm, type FormObject, type FormValue } from './form';
import { checkParams, endpointOf, STRIPE_SPEC_VERSION } from './params';

// A stand-in for the Stripe API in the tests and the local stack (guide step 7.2, ADR 0034). It
// keeps customers, prices, meters, checkouts, subscriptions and invoices in memory, checks every
// parameter against the official spec (params.ts) and sends webhooks signed like Stripe does. The
// SDK of the app talks to it through STRIPE_API_BASE; the hosted checkout is a small page whose
// button pays. Nothing here is secret: it accepts test keys only.

type Json = Record<string, unknown>;

export interface FakeStripeOptions {
  /** Signs the webhooks; the API checks them with the same STRIPE_WEBHOOK_SECRET. */
  webhookSecret: string;
  /** Where the webhooks go, for example http://127.0.0.1:3001/api/webhooks/stripe. */
  webhookUrl?: string;
  /** 0 picks a free port. */
  port?: number;
  /** The clock of the subscriptions, in seconds since the epoch. */
  now?: () => number;
}

export interface FakeRequest {
  method: string;
  path: string;
  params: FormObject;
  idempotencyKey: string | null;
}

export interface FakeMeterEvent {
  eventName: string;
  identifier: string;
  customerId: string;
  value: string;
  timestamp: number;
}

export interface FakeWebhook {
  type: string;
  objectId: string;
  status: number;
}

export type FakeSubscriptionStatus =
  'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused';

class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

const MONTH_SECONDS = 30 * 24 * 60 * 60;

const stringOf = (value: FormValue | undefined): string | null => (typeof value === 'string' ? value : null);
const objectOf = (value: FormValue | undefined): FormObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const listOf = (value: FormValue | undefined): FormValue[] => (Array.isArray(value) ? value : []);

/** Signs a payload like Stripe: HMAC-SHA256 over "{timestamp}.{payload}" with the secret. */
export function stripeSignature(payload: string, secret: string, timestamp: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${String(timestamp)},v1=${signature}`;
}

export class FakeStripe {
  readonly requests: FakeRequest[] = [];
  readonly meterEvents: FakeMeterEvent[] = [];
  readonly webhooks: FakeWebhook[] = [];
  readonly customers = new Map<string, Json>();
  readonly products = new Map<string, Json>();
  readonly prices = new Map<string, Json>();
  readonly meters = new Map<string, Json>();
  readonly checkouts = new Map<string, Json & { line_items: { price: string; quantity?: number }[] }>();
  readonly subscriptions = new Map<string, Json>();
  readonly invoices = new Map<string, Json>();
  readonly portalConfigurations = new Map<string, Json>();
  webhookUrl: string | undefined;
  private readonly idempotent = new Map<string, { status: number; body: unknown }>();
  /** The prices each lookup key had, so that a fake that starts again gives its prices the same ids. */
  private readonly lookupKeyPrices = new Map<string, number>();
  private readonly meterIdentifiers = new Set<string>();
  private counter = 0;

  private constructor(
    private readonly server: Server,
    readonly url: string,
    private readonly options: FakeStripeOptions,
  ) {
    this.webhookUrl = options.webhookUrl;
  }

  static async start(options: FakeStripeOptions): Promise<FakeStripe> {
    const started: { fake?: FakeStripe } = {};
    const server = createServer((request, response) => {
      void started.fake?.handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    started.fake = new FakeStripe(server, `http://127.0.0.1:${String(port)}`, options);
    return started.fake;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /** The parameters of the requests to one endpoint, for example 'POST /v1/checkout/sessions'. */
  requestsTo(endpoint: string): FakeRequest[] {
    return this.requests.filter((request) => endpointOf(request.method, request.path) === endpoint);
  }

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${randomBytes(6).toString('hex')}${String(this.counter)}`;
  }

  // -- Control: what the customer or Stripe does in the real world ---------------------------------

  /** The customer pays the checkout: an active subscription and a paid invoice, with their webhooks. */
  async completeCheckout(sessionId: string): Promise<Json> {
    const session = this.checkouts.get(sessionId);
    if (!session || session['status'] !== 'open') {
      throw new Error(`No open checkout ${sessionId}`);
    }
    const created = this.now();
    const subscriptionId = this.id('sub');
    const subscription: Json = {
      id: subscriptionId,
      object: 'subscription',
      customer: session['customer'],
      status: 'active',
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      start_date: created,
      created,
      trial_end: null,
      livemode: false,
      metadata: objectOf(session['subscription_data'] as FormValue)['metadata'] ?? {},
      items: {
        object: 'list',
        has_more: false,
        data: session.line_items.map((item) =>
          this.subscriptionItem(subscriptionId, item.price, created, item.quantity),
        ),
      },
    };
    this.subscriptions.set(subscriptionId, subscription);
    Object.assign(session, { status: 'complete', payment_status: 'paid', subscription: subscriptionId });
    await this.send('checkout.session.completed', session);
    await this.send('customer.subscription.created', subscription);
    await this.invoice(subscription, 'paid');
    return subscription;
  }

  /** Stripe changes the status, for example to past_due after a failed renewal. */
  async setSubscriptionStatus(subscriptionId: string, status: FakeSubscriptionStatus): Promise<void> {
    const subscription = this.subscription(subscriptionId);
    subscription['status'] = status;
    if (status === 'past_due' || status === 'unpaid') {
      await this.invoice(subscription, 'open');
    } else if (status === 'active') {
      await this.invoice(subscription, 'paid');
    }
    await this.send(
      status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
      subscription,
    );
  }

  /** The customer cancels in the portal: at the end of the period, or at once. */
  async cancelSubscription(subscriptionId: string, atPeriodEnd = false): Promise<void> {
    const subscription = this.subscription(subscriptionId);
    if (atPeriodEnd) {
      subscription['cancel_at_period_end'] = true;
      await this.send('customer.subscription.updated', subscription);
      return;
    }
    Object.assign(subscription, { status: 'canceled', canceled_at: this.now(), ended_at: this.now() });
    await this.send('customer.subscription.deleted', subscription);
  }

  /** Signs an event about an object and posts it to the webhook URL, like Stripe. */
  async send(type: string, object: Json): Promise<number> {
    const created = this.now();
    const event = {
      id: this.id('evt'),
      object: 'event',
      api_version: STRIPE_SPEC_VERSION,
      created,
      type,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: { object: structuredClone(object) },
    };
    const payload = JSON.stringify(event);
    let status = 0;
    if (this.webhookUrl) {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSignature(
            payload,
            this.options.webhookSecret,
            Math.floor(Date.now() / 1000),
          ),
        },
        body: payload,
      });
      status = response.status;
    }
    this.webhooks.push({ type, objectId: String(object['id']), status });
    return status;
  }

  // -- The API --------------------------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        request.on('error', reject);
      });
      if (!url.pathname.startsWith('/v1/')) {
        await this.page(request.method ?? 'GET', url, response);
        return;
      }
      const authorization = request.headers['authorization'] ?? '';
      if (!/^Bearer (sk|rk)_test_\S+$/.test(authorization)) {
        throw new StripeError(401, 'Invalid API Key provided.');
      }
      const method = request.method ?? 'GET';
      const params = method === 'GET' ? decodeForm(url.search.slice(1)) : decodeForm(body);
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;
      this.requests.push({ method, path: url.pathname, params, idempotencyKey });
      const template = endpointOf(method, url.pathname);
      if (!template) {
        throw new StripeError(404, `Unrecognized request URL (${method}: ${url.pathname}).`);
      }
      const problem = checkParams(template, params);
      if (problem) {
        throw new StripeError(400, problem);
      }
      const replay = idempotencyKey ? this.idempotent.get(`${template}:${idempotencyKey}`) : undefined;
      if (replay) {
        this.reply(response, replay.status, replay.body);
        return;
      }
      const result = this.route(template, url.pathname, params);
      if (idempotencyKey && method === 'POST') {
        this.idempotent.set(`${template}:${idempotencyKey}`, { status: 200, body: result });
      }
      this.reply(response, 200, result);
    } catch (error) {
      if (error instanceof StripeError) {
        this.reply(response, error.status, {
          error: {
            type: error.status === 401 ? 'authentication_error' : 'invalid_request_error',
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(error.param ? { param: error.param } : {}),
          },
        });
        return;
      }
      this.reply(response, 500, { error: { type: 'api_error', message: String(error) } });
    }
  }

  private reply(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'request-id': this.id('req') });
    response.end(JSON.stringify(body));
  }

  private route(template: string, path: string, params: FormObject): unknown {
    const id = path.split('/').pop() ?? '';
    switch (template) {
      case 'POST /v1/customers':
        return this.createCustomer(params);
      case 'GET /v1/customers/{customer}':
        return this.found(this.customers, id, 'customer');
      case 'POST /v1/products':
        return this.createProduct(params);
      case 'GET /v1/products/{id}':
        return this.found(this.products, id, 'product');
      case 'POST /v1/products/{id}':
        return Object.assign(this.found(this.products, id, 'product'), this.plain(params));
      case 'POST /v1/prices':
        return this.createPrice(params);
      case 'GET /v1/prices':
        return this.listPrices(params);
      case 'POST /v1/billing/meters':
        return this.createMeter(params);
      case 'GET /v1/billing/meters':
        return this.list([...this.meters.values()].filter((meter) => meter['status'] === 'active'));
      case 'POST /v1/billing/meter_events':
        return this.createMeterEvent(params);
      case 'POST /v1/checkout/sessions':
        return this.createCheckout(params);
      case 'POST /v1/billing_portal/sessions':
        return this.createPortalSession(params);
      case 'GET /v1/billing_portal/configurations':
        return this.list([...this.portalConfigurations.values()]);
      case 'POST /v1/billing_portal/configurations':
        return this.savePortalConfiguration(null, params);
      case 'POST /v1/billing_portal/configurations/{configuration}':
        return this.savePortalConfiguration(id, params);
      case 'GET /v1/subscriptions/{subscription_exposed_id}':
        return this.found(this.subscriptions, id, 'subscription');
      case 'POST /v1/subscriptions/{subscription_exposed_id}':
        return this.updateSubscription(id, params);
      case 'GET /v1/invoices':
        return this.list(
          [...this.invoices.values()]
            .filter((invoice) => invoice['customer'] === stringOf(params['customer']))
            .sort((a, b) => Number(b['created']) - Number(a['created'])),
        );
      default:
        throw new StripeError(404, `Unrecognized request URL (${template}).`);
    }
  }

  private list(data: Json[]): Json {
    return { object: 'list', data, has_more: false, url: '/v1/list' };
  }

  private found(store: Map<string, Json>, id: string, kind: string): Json {
    const object = store.get(id);
    if (!object) {
      throw new StripeError(404, `No such ${kind}: '${id}'`, 'resource_missing', 'id');
    }
    return object;
  }

  private subscription(id: string): Json {
    return this.found(this.subscriptions, id, 'subscription');
  }

  /** Form values as they are, without the parameters that only steer the request. */
  private plain(params: FormObject): FormObject {
    return Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'expand'));
  }

  private createCustomer(params: FormObject): Json {
    const customer: Json = {
      id: this.id('cus'),
      object: 'customer',
      created: this.now(),
      email: stringOf(params['email']),
      name: stringOf(params['name']),
      metadata: objectOf(params['metadata']),
      preferred_locales: listOf(params['preferred_locales']),
      test_clock: stringOf(params['test_clock']),
      livemode: false,
    };
    this.customers.set(String(customer['id']), customer);
    return customer;
  }

  private createProduct(params: FormObject): Json {
    const id = stringOf(params['id']) ?? this.id('prod');
    if (this.products.has(id)) {
      throw new StripeError(400, `Product already exists.`, 'resource_already_exists', 'id');
    }
    const product: Json = {
      id,
      object: 'product',
      created: this.now(),
      active: true,
      name: stringOf(params['name']),
      metadata: objectOf(params['metadata']),
      tax_code: stringOf(params['tax_code']),
      livemode: false,
    };
    this.products.set(id, product);
    return product;
  }

  private createPrice(params: FormObject): Json {
    const product = stringOf(params['product']);
    if (!product || !this.products.has(product)) {
      throw new StripeError(400, `No such product: '${String(product)}'`, 'resource_missing', 'product');
    }
    const recurring = objectOf(params['recurring']);
    const lookupKey = stringOf(params['lookup_key']);
    if (lookupKey) {
      const holder = [...this.prices.values()].find((price) => price['lookup_key'] === lookupKey);
      if (holder && params['transfer_lookup_key'] !== 'true') {
        throw new StripeError(400, 'A price with this lookup_key exists already.', undefined, 'lookup_key');
      }
      if (holder) {
        holder['lookup_key'] = null;
      }
    }
    const unitAmount = stringOf(params['unit_amount']);
    // An app that keeps the id of a price for a while finds it again after the fake restarted.
    const version = lookupKey ? (this.lookupKeyPrices.get(lookupKey) ?? 0) + 1 : 0;
    if (lookupKey) {
      this.lookupKeyPrices.set(lookupKey, version);
    }
    const price: Json = {
      id: lookupKey ? `price_${lookupKey}_${String(version)}` : this.id('price'),
      object: 'price',
      created: this.now(),
      active: true,
      currency: stringOf(params['currency']),
      product,
      lookup_key: lookupKey,
      nickname: stringOf(params['nickname']),
      unit_amount: unitAmount === null ? null : Number(unitAmount),
      unit_amount_decimal: stringOf(params['unit_amount_decimal']) ?? unitAmount,
      billing_scheme: stringOf(params['billing_scheme']) ?? 'per_unit',
      tax_behavior: stringOf(params['tax_behavior']) ?? 'unspecified',
      type: 'recurring',
      recurring: {
        interval: stringOf(recurring['interval']),
        interval_count: Number(stringOf(recurring['interval_count']) ?? 1),
        usage_type: stringOf(recurring['usage_type']) ?? 'licensed',
        meter: stringOf(recurring['meter']),
      },
      metadata: objectOf(params['metadata']),
      livemode: false,
    };
    this.prices.set(String(price['id']), price);
    return price;
  }

  private listPrices(params: FormObject): Json {
    const keys = listOf(params['lookup_keys']).map(String);
    const active = stringOf(params['active']);
    return this.list(
      [...this.prices.values()].filter(
        (price) =>
          (keys.length === 0 || keys.includes(String(price['lookup_key']))) &&
          (active === null || String(price['active']) === active),
      ),
    );
  }

  private createMeter(params: FormObject): Json {
    const eventName = stringOf(params['event_name']);
    if ([...this.meters.values()].some((meter) => meter['event_name'] === eventName)) {
      throw new StripeError(400, 'A meter with this event_name exists already.', undefined, 'event_name');
    }
    const meter: Json = {
      id: this.id('mtr'),
      object: 'billing.meter',
      created: this.now(),
      status: 'active',
      display_name: stringOf(params['display_name']),
      event_name: eventName,
      default_aggregation: objectOf(params['default_aggregation']),
      customer_mapping: objectOf(params['customer_mapping']),
      value_settings: objectOf(params['value_settings']),
      livemode: false,
    };
    this.meters.set(String(meter['id']), meter);
    return meter;
  }

  private createMeterEvent(params: FormObject): Json {
    const payload = objectOf(params['payload']);
    const eventName = stringOf(params['event_name']) ?? '';
    const meter = [...this.meters.values()].find((entry) => entry['event_name'] === eventName);
    if (!meter) {
      throw new StripeError(
        400,
        `No active meter found for event_name ${eventName}.`,
        undefined,
        'event_name',
      );
    }
    const identifier = stringOf(params['identifier']) ?? this.id('mev');
    const customerId = stringOf(payload['stripe_customer_id']) ?? '';
    const value = stringOf(payload['value']) ?? '';
    if (!this.customers.has(customerId) || !/^\d+$/.test(value)) {
      throw new StripeError(
        400,
        'The payload needs stripe_customer_id and a whole number value.',
        undefined,
        'payload',
      );
    }
    // Stripe takes an identifier once for at least 24 hours.
    if (!this.meterIdentifiers.has(identifier)) {
      this.meterIdentifiers.add(identifier);
      this.meterEvents.push({
        eventName,
        identifier,
        customerId,
        value,
        timestamp: Number(stringOf(params['timestamp']) ?? this.now()),
      });
    }
    return {
      object: 'billing.meter_event',
      event_name: eventName,
      identifier,
      payload,
      created: this.now(),
      livemode: false,
    };
  }

  private priceOf(id: string): Json {
    return this.found(this.prices, id, 'price');
  }

  private createCheckout(params: FormObject): Json {
    if (stringOf(params['mode']) !== 'subscription') {
      throw new StripeError(400, 'The fake Stripe sells subscriptions only.', undefined, 'mode');
    }
    const customer = stringOf(params['customer']);
    if (!customer || !this.customers.has(customer)) {
      throw new StripeError(400, `No such customer: '${String(customer)}'`, 'resource_missing', 'customer');
    }
    const lineItems = listOf(params['line_items']).map((entry) => {
      const item = objectOf(entry);
      const price = this.priceOf(stringOf(item['price']) ?? '');
      const recurring = price['recurring'] as Json;
      if (recurring['usage_type'] === 'metered' && item['quantity'] !== undefined) {
        throw new StripeError(400, 'Quantity cannot be set for metered prices.', undefined, 'line_items');
      }
      return {
        price: String(price['id']),
        ...(item['quantity'] === undefined ? {} : { quantity: Number(stringOf(item['quantity'])) }),
      };
    });
    const id = this.id('cs_test');
    const session = {
      id,
      object: 'checkout.session',
      url: `${this.url}/checkout/${id}`,
      mode: 'subscription',
      status: 'open',
      payment_status: 'unpaid',
      customer,
      client_reference_id: stringOf(params['client_reference_id']),
      subscription: null,
      metadata: objectOf(params['metadata']),
      subscription_data: objectOf(params['subscription_data']),
      automatic_tax: { enabled: objectOf(params['automatic_tax'])['enabled'] === 'true' },
      locale: stringOf(params['locale']),
      success_url: stringOf(params['success_url']),
      cancel_url: stringOf(params['cancel_url']),
      created: this.now(),
      livemode: false,
      line_items: lineItems,
    };
    this.checkouts.set(id, session);
    return session;
  }

  private createPortalSession(params: FormObject): Json {
    const customer = stringOf(params['customer']);
    if (!customer || !this.customers.has(customer)) {
      throw new StripeError(400, `No such customer: '${String(customer)}'`, 'resource_missing', 'customer');
    }
    const id = this.id('bps');
    return {
      id,
      object: 'billing_portal.session',
      url: `${this.url}/portal/${id}?return=${encodeURIComponent(stringOf(params['return_url']) ?? '')}`,
      customer,
      return_url: stringOf(params['return_url']),
      configuration: stringOf(params['configuration']),
      locale: stringOf(params['locale']),
      created: this.now(),
      livemode: false,
    };
  }

  private savePortalConfiguration(id: string | null, params: FormObject): Json {
    const existing = id ? this.found(this.portalConfigurations, id, 'billing_portal.configuration') : null;
    const configuration: Json = existing ?? {
      id: this.id('bpc'),
      object: 'billing_portal.configuration',
      active: true,
      is_default: this.portalConfigurations.size === 0,
      created: this.now(),
      livemode: false,
    };
    Object.assign(configuration, this.plain(params));
    this.portalConfigurations.set(String(configuration['id']), configuration);
    return configuration;
  }

  private subscriptionItem(subscriptionId: string, priceId: string, start: number, quantity?: number): Json {
    return {
      id: this.id('si'),
      object: 'subscription_item',
      subscription: subscriptionId,
      price: this.priceOf(priceId),
      quantity: quantity ?? null,
      current_period_start: start,
      current_period_end: start + MONTH_SECONDS,
      created: start,
      metadata: {},
    };
  }

  private updateSubscription(id: string, params: FormObject): Json {
    const subscription = this.subscription(id);
    const items = (subscription['items'] as { data: Json[] }).data;
    for (const entry of listOf(params['items'])) {
      const change = objectOf(entry);
      const item = items.find((candidate) => candidate['id'] === stringOf(change['id']));
      if (!item) {
        throw new StripeError(
          400,
          `No such subscription item: '${String(stringOf(change['id']))}'`,
          'resource_missing',
          'items',
        );
      }
      item['price'] = this.priceOf(stringOf(change['price']) ?? '');
    }
    const cancelAtPeriodEnd = stringOf(params['cancel_at_period_end']);
    if (cancelAtPeriodEnd !== null) {
      subscription['cancel_at_period_end'] = cancelAtPeriodEnd === 'true';
    }
    void this.send('customer.subscription.updated', subscription);
    return subscription;
  }

  private async invoice(subscription: Json, status: 'paid' | 'open'): Promise<void> {
    const items = (subscription['items'] as { data: Json[] }).data;
    const total = items.reduce((sum, item) => sum + Number((item['price'] as Json)['unit_amount'] ?? 0), 0);
    const id = this.id('in');
    const invoice: Json = {
      id,
      object: 'invoice',
      number: `FAKE-${String(this.invoices.size + 1).padStart(4, '0')}`,
      status,
      customer: subscription['customer'],
      currency: (items[0]?.['price'] as Json | undefined)?.['currency'] ?? 'eur',
      total,
      amount_due: total,
      amount_paid: status === 'paid' ? total : 0,
      created: this.now(),
      hosted_invoice_url: `${this.url}/invoices/${id}`,
      invoice_pdf: `${this.url}/invoices/${id}.pdf`,
      parent: { type: 'subscription_details', subscription_details: { subscription: subscription['id'] } },
      livemode: false,
    };
    this.invoices.set(id, invoice);
    await this.send(status === 'paid' ? 'invoice.paid' : 'invoice.payment_failed', invoice);
  }

  // -- The hosted pages ------------------------------------------------------------------------------

  private async page(method: string, url: URL, response: ServerResponse): Promise<void> {
    const checkout = /^\/checkout\/([^/]+)(\/pay)?$/.exec(url.pathname);
    if (checkout?.[1]) {
      const session = this.checkouts.get(checkout[1]);
      if (!session) {
        response.writeHead(404).end();
        return;
      }
      if (method === 'POST' && checkout[2]) {
        await this.completeCheckout(checkout[1]);
        response.writeHead(303, { location: String(session['success_url']) }).end();
        return;
      }
      const lines = session.line_items
        .map((item) => `<li>${String(this.priceOf(item.price)['lookup_key'])}</li>`)
        .join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><head><title>Fake Stripe Checkout</title></head><body>` +
          `<h1>Fake Stripe Checkout</h1><ul>${lines}</ul>` +
          `<form method="post" action="/checkout/${checkout[1]}/pay"><button type="submit">Pay</button></form>` +
          `<a href="${String(session['cancel_url'])}">Back</a></body></html>`,
      );
      return;
    }
    const portal = /^\/portal\/([^/]+)$/.exec(url.pathname);
    if (portal) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><head><title>Fake Stripe Portal</title></head><body>` +
          `<h1>Fake Stripe Portal</h1><a href="${url.searchParams.get('return') ?? '/'}">Back</a></body></html>`,
      );
      return;
    }
    response.writeHead(404).end();
  }
}
