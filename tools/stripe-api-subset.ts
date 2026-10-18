// Extracts the parameters of the Stripe endpoints the app uses from the official OpenAPI spec of
// Stripe into packages/testing/src/stripe/api-subset.json, which the fake Stripe of the tests
// checks every request against (ADR 0034). Run it after a new API version:
//
//   curl -sSLo /tmp/spec3.json https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
//   pnpm exec tsx tools/stripe-api-subset.ts /tmp/spec3.json
//   pnpm exec prettier --write packages/testing/src/stripe/api-subset.json

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Tree = true | '*' | { [key: string]: Tree };

interface Schema {
  $ref?: string;
  type?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  additionalProperties?: unknown;
  required?: string[];
}

interface Spec {
  info: { version: string };
  components: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: { in: string; name: string; schema: Schema }[];
        requestBody?: { content: Record<string, { schema: Schema }> };
      }
    >
  >;
}

const POST = [
  '/v1/customers',
  '/v1/checkout/sessions',
  '/v1/billing_portal/sessions',
  '/v1/billing_portal/configurations',
  '/v1/billing_portal/configurations/{configuration}',
  '/v1/subscriptions/{subscription_exposed_id}',
  '/v1/billing/meter_events',
  '/v1/billing/meters',
  '/v1/products',
  '/v1/products/{id}',
  '/v1/prices',
];
const DELETE = ['/v1/customers/{customer}'];
const GET = [
  '/v1/customers/{customer}',
  '/v1/prices',
  '/v1/products/{id}',
  '/v1/billing/meters',
  '/v1/billing_portal/configurations',
  '/v1/subscriptions/{subscription_exposed_id}',
  '/v1/invoices',
];

const [specPath] = process.argv.slice(2);
if (!specPath) {
  throw new Error('Usage: tsx tools/stripe-api-subset.ts <path of spec3.json>');
}
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;

const resolved = (schema: Schema | undefined): Schema | undefined => {
  let current = schema;
  while (current?.$ref) {
    current = spec.components.schemas[current.$ref.split('/').pop() ?? ''];
  }
  return current;
};

function treeOf(input: Schema | undefined, depth: number): Tree {
  const schema = resolved(input);
  if (!schema) {
    return true;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    // An object or an empty string (to unset it): the keys of every object alternative.
    let merged: Record<string, Tree> | null = null;
    for (const alternative of alternatives) {
      const tree = treeOf(alternative, depth);
      if (tree === '*') {
        return '*';
      }
      if (typeof tree === 'object') {
        merged = { ...(merged ?? {}), ...tree };
      }
    }
    return merged ?? true;
  }
  if (schema.type === 'array') {
    const items = treeOf(schema.items, depth);
    return items === true ? true : { '[]': items };
  }
  if (schema.type === 'object') {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      return schema.additionalProperties ? '*' : true;
    }
    if (depth <= 0) {
      return '*';
    }
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, treeOf(value, depth - 1)]),
    );
  }
  return true;
}

const endpoints: Record<string, { required: string[]; params: Tree }> = {};
for (const path of POST) {
  const body = spec.paths[path]?.['post']?.requestBody?.content['application/x-www-form-urlencoded']?.schema;
  if (!body) {
    throw new Error(`The spec has no POST ${path}`);
  }
  endpoints[`POST ${path}`] = { required: body.required ?? [], params: treeOf(body, 4) };
}
for (const path of GET) {
  const parameters = spec.paths[path]?.['get']?.parameters;
  if (!parameters) {
    throw new Error(`The spec has no GET ${path}`);
  }
  endpoints[`GET ${path}`] = {
    required: [],
    params: Object.fromEntries(
      parameters
        .filter((entry) => entry.in === 'query')
        .map((entry) => [entry.name, treeOf(entry.schema, 3)]),
    ),
  };
}

for (const path of DELETE) {
  const body =
    spec.paths[path]?.['delete']?.requestBody?.content['application/x-www-form-urlencoded']?.schema;
  if (!spec.paths[path]?.['delete']) {
    throw new Error(`The spec has no DELETE ${path}`);
  }
  // A delete takes no parameters: an object without properties.
  const params = body?.properties && Object.keys(body.properties).length > 0 ? treeOf(body, 4) : {};
  endpoints[`DELETE ${path}`] = { required: body?.required ?? [], params };
}

const target = resolve(__dirname, '../packages/testing/src/stripe/api-subset.json');
writeFileSync(
  target,
  `${JSON.stringify({ source: 'https://github.com/stripe/openapi (openapi/spec3.json)', apiVersion: spec.info.version, endpoints })}\n`,
);
console.log(
  `${String(Object.keys(endpoints).length)} endpoints of API version ${spec.info.version} written to ${target}`,
);
