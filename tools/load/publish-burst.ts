// The load test of guide step 8.5 (ADR 0041), for k6 2.3. While the scenario "reads" browses the
// workspaces of the fixture at a fixed rate, the posts of the fixture fall due in the same minute,
// and the scenario "publishing" follows them through the API until every one is published.
//
// The targets of the guide are the thresholds below; k6 exits with code 99 when one is missed:
// - every due variant is published, none more than 60 seconds after its due time;
// - reads answer with a p95 below 300 ms, over the whole run and in the minute the posts go out.
//
// Every owner of the fixture signs in once in setup() and acts as one client: its requests carry
// an address of its own in X-Real-IP, as the reverse proxy passes it (ADR 0006), so the limits per
// address and per person apply as they would to that many people. API_URL may name several
// instances of the API, separated by commas; the requests take turns, as the reverse proxy spreads
// them over its replicas.
//
// Run after `pnpm load:fixture`, with the variables of .env in the environment (README):
//   k6 run --summary-export tools/load/summary.json tools/load/publish-burst.ts

import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import http, { type RefinedResponse, type ResponseType } from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';

interface FixtureWorkspace {
  slug: string;
  email: string;
  /** Posts to open in the composer. */
  postIds: string[];
  dueVariants: number;
}

interface Fixture {
  run: string;
  dueAt: string;
  spreadSeconds: number;
  dueVariants: number;
  workspaces: FixtureWorkspace[];
}

interface Session {
  cookie: string;
  address: string;
}

interface SetupData {
  sessions: Session[];
}

interface ListedVariant {
  id: string;
  scheduledAt: string;
  publishedAt: string;
}

interface Read {
  name: string;
  weight: number;
  path: (workspace: FixtureWorkspace, iteration: number) => string;
}

const API_URLS = (__ENV['API_URL'] ?? 'http://localhost:3001')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);
/** The origin Better Auth trusts (APP_URL); it refuses sign-ins without it. */
const APP_URL = __ENV['APP_URL'] ?? 'http://localhost:3000';
const PASSWORD = __ENV['SEED_USER_PASSWORD'];
/** Reads per second of all owners together. */
const READ_RATE = Number(__ENV['READ_RATE'] ?? '100');
/** VUs that follow the publishing, each for a share of the workspaces. */
const WATCHERS = Number(__ENV['WATCHERS'] ?? '10');
/** How long the reads go on after the minute the posts go out in. */
const AFTER_SECONDS = Number(__ENV['AFTER_SECONDS'] ?? '120');

/** The targets of the guide. */
const MAX_PUBLISH_LAG_MS = 60_000;
const READ_P95_MS = 300;

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;
/** How long the publishing is followed after its minute before the run gives up. */
const WATCH_MS = 5 * 60 * SECOND_MS;
const POLL_SECONDS = 3;
const SIGN_INS_AT_ONCE = 10;

/** The instance of the API for the n-th request. */
const apiUrl = (n: number): string => API_URLS[n % API_URLS.length] ?? 'http://localhost:3001';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isWorkspace = (value: unknown): value is FixtureWorkspace =>
  isRecord(value) &&
  typeof value['slug'] === 'string' &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value['slug']) &&
  typeof value['email'] === 'string' &&
  Array.isArray(value['postIds']) &&
  value['postIds'].length > 0 &&
  value['postIds'].every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) &&
  typeof value['dueVariants'] === 'number';

/** The file of `pnpm load:fixture`, checked before anything relies on it. */
function parseFixture(text: string): Fixture {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value['run'] !== 'string' ||
    typeof value['dueAt'] !== 'string' ||
    Number.isNaN(Date.parse(value['dueAt'])) ||
    typeof value['spreadSeconds'] !== 'number' ||
    typeof value['dueVariants'] !== 'number' ||
    !Array.isArray(value['workspaces']) ||
    value['workspaces'].length === 0 ||
    !value['workspaces'].every(isWorkspace)
  ) {
    throw new Error('The fixture file does not describe a run; write it with pnpm load:fixture.');
  }
  return value as unknown as Fixture;
}

const fixture = parseFixture(open(__ENV['FIXTURE'] ?? './fixture.json'));
const dueAtMs = Date.parse(fixture.dueAt);
const spreadMs = fixture.spreadSeconds * SECOND_MS;
/** The minute the posts go out in: from the first due time to a minute after the last. */
const burstEndMs = dueAtMs + spreadMs + 60 * SECOND_MS;
/** The planned times of the due posts, as the variant list filters them (from inclusive, to exclusive). */
const DUE_FROM = new Date(dueAtMs).toISOString();
const DUE_TO = new Date(dueAtMs + spreadMs + SECOND_MS).toISOString();
/** The week of the calendar around the due minute. */
const WEEK_FROM = new Date(dueAtMs - 3 * DAY_MS).toISOString();
const WEEK_TO = new Date(dueAtMs + 4 * DAY_MS).toISOString();

const initAt = Date.now();
const readSeconds = Math.max(60, Math.ceil((burstEndMs + AFTER_SECONDS * SECOND_MS - initAt) / SECOND_MS));
const watchSeconds = Math.max(60, Math.ceil((burstEndMs + WATCH_MS - initAt) / SECOND_MS));
const watchers = Math.max(1, Math.min(WATCHERS, fixture.workspaces.length));

export const options: Options = {
  // Every owner signs in first; scrypt takes its time on the API.
  setupTimeout: '5m',
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      exec: 'read',
      rate: READ_RATE,
      timeUnit: '1s',
      duration: `${String(readSeconds)}s`,
      preAllocatedVUs: Math.max(20, Math.ceil(READ_RATE / 2)),
      maxVUs: Math.max(100, READ_RATE * 3),
    },
    publishing: {
      executor: 'per-vu-iterations',
      exec: 'watch',
      vus: watchers,
      iterations: 1,
      maxDuration: `${String(watchSeconds)}s`,
    },
  },
  thresholds: {
    'http_req_duration{kind:read}': [`p(95)<${String(READ_P95_MS)}`],
    'http_req_duration{kind:read,phase:burst}': [`p(95)<${String(READ_P95_MS)}`],
    'http_req_duration{kind:progress}': [`p(95)<${String(READ_P95_MS)}`],
    'http_req_failed{kind:read}': ['rate<0.01'],
    checks: ['rate>0.99'],
    variants_published: [`count>=${String(fixture.dueVariants)}`],
    publish_lag: [`max<${String(MAX_PUBLISH_LAG_MS)}`],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const published = new Counter('variants_published');
const publishLag = new Trend('publish_lag', true);

/** What people open in the app, weighted by how often; the app shell asks for the count of unread notifications. */
const ME: Read = { name: 'me', weight: 4, path: () => '/api/me' };
const READS: readonly Read[] = [
  {
    name: 'calendar week',
    weight: 15,
    path: (w) => `/api/w/${w.slug}/variants?from=${WEEK_FROM}&to=${WEEK_TO}&order=schedule&limit=500`,
  },
  { name: 'post list', weight: 15, path: (w) => `/api/w/${w.slug}/variants?limit=50` },
  {
    name: 'next posts',
    weight: 10,
    path: (w) =>
      `/api/w/${w.slug}/variants?status=SCHEDULED,QUEUED,PUBLISHING,RETRYING&order=schedule&limit=10`,
  },
  {
    name: 'composer',
    weight: 10,
    path: (w, iteration) => `/api/w/${w.slug}/posts/${w.postIds[iteration % w.postIds.length] ?? ''}`,
  },
  { name: 'accounts', weight: 8, path: (w) => `/api/w/${w.slug}/accounts` },
  { name: 'analytics overview', weight: 8, path: (w) => `/api/w/${w.slug}/analytics/overview` },
  {
    name: 'analytics timeseries',
    weight: 6,
    path: (w) => `/api/w/${w.slug}/analytics/timeseries?metric=impressions&granularity=day&groupBy=platform`,
  },
  { name: 'top posts', weight: 4, path: (w) => `/api/w/${w.slug}/analytics/top-posts?limit=5` },
  { name: 'media library', weight: 6, path: (w) => `/api/w/${w.slug}/media?limit=30` },
  { name: 'unread notifications', weight: 10, path: () => '/api/me/notifications/unread-count' },
  { name: 'workspace', weight: 4, path: (w) => `/api/w/${w.slug}` },
  ME,
];
const TOTAL_WEIGHT = READS.reduce((sum, entry) => sum + entry.weight, 0);

function pickRead(): Read {
  let point = Math.random() * TOTAL_WEIGHT;
  for (const entry of READS) {
    point -= entry.weight;
    if (point < 0) {
      return entry;
    }
  }
  return ME;
}

/** A private address per owner, as the reverse proxy would pass it in X-Real-IP. */
function addressOf(index: number): string {
  const n = index + 1;
  return `10.${String(Math.floor(n / 65_536) % 256)}.${String(Math.floor(n / 256) % 256)}.${String(n % 256)}`;
}

const phaseAt = (at: number): string => (at < dueAtMs ? 'before' : at < burstEndMs ? 'burst' : 'after');

/** A request of an owner: its cookie and address, and a jar of its own instead of the one of the VU. */
const paramsOf = (session: Session, tags: Record<string, string>) => ({
  headers: { Cookie: session.cookie, 'X-Real-IP': session.address },
  jar: new http.CookieJar(),
  tags,
});

function cookieOf(response: RefinedResponse<ResponseType | undefined>): string | null {
  const pairs = Object.entries(response.cookies).flatMap(([name, values]) => {
    const [first] = values;
    return first ? [`${name}=${first.value}`] : [];
  });
  return pairs.some((pair) => pair.includes('session_token=')) ? pairs.join('; ') : null;
}

/** The published variants of a page of the variant list, or null for an answer that is none. */
function publishedOf(response: RefinedResponse<ResponseType | undefined>): ListedVariant[] | null {
  if (response.status !== 200) {
    return null;
  }
  const body: unknown = response.json();
  if (!isRecord(body) || !Array.isArray(body['items'])) {
    return null;
  }
  return body['items'].filter(
    (item): item is ListedVariant =>
      isRecord(item) &&
      typeof item['id'] === 'string' &&
      typeof item['scheduledAt'] === 'string' &&
      typeof item['publishedAt'] === 'string',
  );
}

export function setup(): SetupData {
  if (!PASSWORD) {
    fail('Set SEED_USER_PASSWORD, the password the fixture gave the owners.');
  }
  if (Date.now() > dueAtMs - 60 * SECOND_MS) {
    fail(
      `The posts of run ${fixture.run} fall due at ${fixture.dueAt}, too soon to read before; write a new fixture.`,
    );
  }
  const sessions: Session[] = [];
  for (let start = 0; start < fixture.workspaces.length; start += SIGN_INS_AT_ONCE) {
    const batch = fixture.workspaces.slice(start, start + SIGN_INS_AT_ONCE);
    const responses = http.batch(
      batch.map((workspace, offset) => ({
        method: 'POST',
        url: `${apiUrl(start + offset)}/api/auth/sign-in/email`,
        body: JSON.stringify({ email: workspace.email, password: PASSWORD }),
        params: {
          headers: {
            'Content-Type': 'application/json',
            Origin: APP_URL,
            'X-Real-IP': addressOf(start + offset),
          },
          jar: new http.CookieJar(),
          tags: { kind: 'sign-in' },
        },
      })),
    );
    responses.forEach((response, offset) => {
      const cookie = cookieOf(response);
      if (response.status !== 200 || cookie === null) {
        fail(
          `The owner of ${batch[offset]?.slug ?? '?'} could not sign in: status ${String(response.status)}.`,
        );
      }
      sessions.push({ cookie, address: addressOf(start + offset) });
    });
  }
  return { sessions };
}

/** One read of one owner; the owners take turns. */
export function read(data: SetupData): void {
  const iteration = exec.scenario.iterationInTest;
  const index = iteration % data.sessions.length;
  const session = data.sessions[index];
  const workspace = fixture.workspaces[index];
  if (!session || !workspace) {
    return;
  }
  const entry = pickRead();
  const response = http.get(
    `${apiUrl(iteration)}${entry.path(workspace, iteration)}`,
    paramsOf(session, { kind: 'read', name: entry.name, phase: phaseAt(Date.now()) }),
  );
  check(response, { 'read answered with 200': (r) => r.status === 200 });
}

/** Follows a share of the workspaces until their due variants are published or the time is up. */
export function watch(data: SetupData): void {
  const slot = exec.scenario.iterationInTest;
  let pending = fixture.workspaces.map((_, index) => index).filter((index) => index % watchers === slot);
  const seen = new Set<string>();
  const counts = new Map<number, number>();
  while (Date.now() < dueAtMs) {
    sleep(Math.min(5, (dueAtMs - Date.now()) / SECOND_MS));
  }
  const deadline = burstEndMs + WATCH_MS;
  let requests = slot;
  while (pending.length > 0 && Date.now() < deadline) {
    for (const index of pending) {
      const session = data.sessions[index];
      const workspace = fixture.workspaces[index];
      if (!session || !workspace) {
        continue;
      }
      requests += 1;
      const response = http.get(
        `${apiUrl(requests)}/api/w/${workspace.slug}/variants?status=PUBLISHED&from=${DUE_FROM}&to=${DUE_TO}&order=schedule&limit=500`,
        paramsOf(session, {
          kind: 'progress',
          name: 'published variants of the run',
          phase: phaseAt(Date.now()),
        }),
      );
      const variants = publishedOf(response);
      check(variants, { 'progress answered with the variants': (value) => value !== null });
      for (const variant of variants ?? []) {
        if (seen.has(variant.id)) {
          continue;
        }
        seen.add(variant.id);
        published.add(1);
        publishLag.add(Date.parse(variant.publishedAt) - Date.parse(variant.scheduledAt));
        counts.set(index, (counts.get(index) ?? 0) + 1);
      }
    }
    pending = pending.filter(
      (index) => (counts.get(index) ?? 0) < (fixture.workspaces[index]?.dueVariants ?? 0),
    );
    if (pending.length > 0) {
      sleep(POLL_SECONDS);
    }
  }
  for (const index of pending) {
    const workspace = fixture.workspaces[index];
    console.warn(
      `${workspace?.slug ?? '?'}: ${String(counts.get(index) ?? 0)} of ${String(workspace?.dueVariants ?? 0)} variants published`,
    );
  }
}
