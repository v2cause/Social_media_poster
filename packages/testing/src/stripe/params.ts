import subset from './api-subset.json';
import type { FormObject, FormValue } from './form';

// The parameters of the Stripe endpoints the app uses, extracted from the official OpenAPI spec of
// Stripe (api-subset.json, see its source and apiVersion). The fake Stripe refuses what Stripe
// would refuse as unknown or missing, so the tests notice a parameter the API does not know.

type Tree = true | '*' | { [key: string]: Tree };
interface Endpoint {
  required: string[];
  params: Record<string, Tree>;
}

const endpoints = subset.endpoints as unknown as Record<string, Endpoint>;

export const STRIPE_SPEC_VERSION = subset.apiVersion;

/** The endpoint template a request path belongs to, for example /v1/products/{id}. */
export function endpointOf(method: string, path: string): string | null {
  for (const template of Object.keys(endpoints)) {
    const [templateMethod, templatePath] = template.split(' ');
    if (templateMethod !== method || !templatePath) {
      continue;
    }
    const pattern = new RegExp(`^${templatePath.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    if (pattern.test(path)) {
      return template;
    }
  }
  return null;
}

function unknownIn(value: FormValue, tree: Tree, path: string): string | null {
  if (tree === true || tree === '*') {
    return null;
  }
  if (typeof value === 'string') {
    // An empty string unsets an object parameter.
    return null;
  }
  if (Array.isArray(value)) {
    const items = tree['[]'];
    if (items === undefined) {
      return null;
    }
    for (const [index, item] of value.entries()) {
      const unknown = unknownIn(item, items, `${path}[${String(index)}]`);
      if (unknown) {
        return unknown;
      }
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const subtree = tree[key];
    if (subtree === undefined) {
      return `${path}[${key}]`;
    }
    const unknown = unknownIn(child, subtree, `${path}[${key}]`);
    if (unknown) {
      return unknown;
    }
  }
  return null;
}

/** The first problem of the parameters of a request, as Stripe words it, or null. */
export function checkParams(template: string, params: FormObject): string | null {
  const endpoint = endpoints[template];
  if (!endpoint) {
    return `Unrecognized request URL (${template}).`;
  }
  for (const [key, value] of Object.entries(params)) {
    const tree = endpoint.params[key];
    if (tree === undefined) {
      return `Received unknown parameter: ${key}`;
    }
    const unknown = unknownIn(value, tree, key);
    if (unknown) {
      return `Received unknown parameter: ${unknown}`;
    }
  }
  const missing = endpoint.required.find((key) => !(key in params));
  return missing ? `Missing required param: ${missing}.` : null;
}
