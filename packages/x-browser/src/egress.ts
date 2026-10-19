import { z } from 'zod';

// The hosts the browser of the X adapter may reach (guide step 6.2): the web app of X and the
// storage of the media. The same policy runs twice, in the route of every browser context and in
// the egress proxy of the network, so a request that slips past one still meets the other.
//
// An entry is a host ("x.com"), its subdomains ("*.x.com", which leaves out "x.com" itself) or
// an origin with scheme and port ("https://media.example.com", "http://s3:8333"). A host without
// a scheme is reached over TLS on port 443 only; plain http needs an origin that says so, for
// example the local storage of the development setup. A host with a port and without a scheme
// ("smtp.example.com:587") opens a tunnel to that port, as the egress proxy of API and worker
// needs it for SMTP (guide step 8.9).

/** The hosts of the web app of X for the selector map x-v1, still to be confirmed against the live interface. */
export const X_WEB_HOSTS: readonly string[] = ['x.com', '*.x.com', 'twimg.com', '*.twimg.com'];

export interface EgressPolicy {
  /** Whether a page may load the URL; data and blob URLs stay inside the page. */
  allowsUrl(url: string): boolean;
  /**
   * Whether the proxy may open a tunnel (CONNECT) to the host and port. Node tunnels plain http
   * as well, so an http origin opens a tunnel to its own port.
   */
  allowsTunnel(host: string, port: number): boolean;
  /** Whether the proxy may forward a plain http request to the host and port. */
  allowsPlain(host: string, port: number): boolean;
}

interface Rule {
  host: string;
  subdomains: boolean;
  tls: boolean;
  port: number;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

const invalid = (entry: string): Error => new Error(`Invalid egress entry: ${entry}`);

const ruleOf = (entry: string): Rule => {
  const value = entry.trim().toLowerCase();
  let host = value;
  let tls = true;
  let port = 443;
  if (/^[a-z]+:\/\//.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid(entry);
    }
    const origin =
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === '';
    if (!origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw invalid(entry);
    }
    host = url.hostname;
    tls = url.protocol === 'https:';
    port = url.port === '' ? (tls ? 443 : 80) : Number(url.port);
  } else {
    const withPort = /^(.+):(\d{1,5})$/.exec(value);
    if (withPort) {
      host = withPort[1] ?? '';
      port = Number(withPort[2]);
      if (port < 1 || port > 65_535) {
        throw invalid(entry);
      }
    }
  }
  const subdomains = host.startsWith('*.');
  const name = subdomains ? host.slice(2) : host;
  if (!HOST.test(name)) {
    throw invalid(entry);
  }
  return { host: name, subdomains, tls, port };
};

/** Builds the policy; an entry it cannot read fails the start instead of widening the list. */
export function egressPolicy(entries: readonly string[]): EgressPolicy {
  const rules = entries.map(ruleOf);
  const allowed = (host: string, port: number, tls: boolean | null): boolean => {
    const name = host.toLowerCase();
    return rules.some(
      (rule) =>
        (tls === null || rule.tls === tls) &&
        rule.port === port &&
        (rule.subdomains ? name.endsWith(`.${rule.host}`) : name === rule.host),
    );
  };
  return {
    allowsUrl(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      const port = (fallback: number): number => (parsed.port === '' ? fallback : Number(parsed.port));
      switch (parsed.protocol) {
        case 'data:':
        case 'blob:':
        case 'about:':
          return true;
        case 'https:':
        case 'wss:':
          return allowed(parsed.hostname, port(443), true);
        case 'http:':
        case 'ws:':
          return allowed(parsed.hostname, port(80), false);
        default:
          return false;
      }
    },
    allowsTunnel: (host, port) => allowed(host, port, null),
    allowsPlain: (host, port) => allowed(host, port, false),
  };
}

/** Reads a comma-separated list of entries, for example XB_EGRESS_HOSTS; blank entries drop out. */
export const egressEntriesOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

const readable = (entries: readonly string[]): boolean => {
  try {
    egressPolicy(entries);
    return true;
  } catch {
    return false;
  }
};

/** XB_EGRESS_HOSTS and EGRESS_HOSTS of browser worker and egress proxy: entries the policy can read. */
export const egressHostsEnvSchema = z.string().optional().transform(egressEntriesOf).refine(readable, {
  message: 'Entries are hosts, *.subdomains, hosts with a port or origins like https://media.example.com',
});
