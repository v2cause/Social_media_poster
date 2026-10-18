import { cadenceHours, daysBefore, localDayOf, nextDay, startOfLocalDay } from '@smp/core';
import { uuidv7 } from 'uuidv7';

import { PrismaAnalyticsUnitOfWork } from '../analytics/prisma-analytics-unit-of-work';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import type { Platform, SocialAccountType } from '../generated/prisma/enums';
import { DEMO_USERS, type DemoSeedResult } from './demo';

// Demo analytics of the local workspace (guide step 5.5, architecture 16): four mock accounts
// without tokens, 90 days of published posts with the snapshots of their polling cascade, the
// daily numbers of the accounts and the rollup over all of it, plus a few posts around today in
// the other lasting states (planned, draft, failed, needs attention). The numbers come from a
// fixed pseudo-random sequence, so a seed on the same day writes the same data. The published
// posts are never polled (metrics_next_at is null), because the mock platforms do not know them;
// from the next night on, the worker's mock platforms continue the daily numbers of the accounts
// with their own, and they publish the planned posts when these are due. Snapshots carry the raw
// answer of the mock platforms (MAP_VERSION 1), so they can be normalized again like theirs.

/** The days with demo data before the day of the seed. */
export const DEMO_ANALYTICS_DAYS = 90;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MOCK_MAP_VERSION = 1;

// The scopes the mock connectors ask for (PLATFORM_SCOPES of @smp/platform-adapters), granted in
// full. A scope added there later shows as missing on these accounts, as on a real connection.
const GRANTED_SCOPES: Readonly<Record<Platform, readonly string[]>> = {
  LINKEDIN: [
    'openid',
    'profile',
    'email',
    'w_member_social',
    'r_member_postAnalytics',
    'w_organization_social',
    'r_organization_social',
    'rw_organization_admin',
  ],
  FACEBOOK: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'read_insights'],
  INSTAGRAM: [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_insights',
  ],
  X: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
};

type StyleKey =
  'professional' | 'storytelling' | 'casual' | 'educational' | 'thought_leadership' | 'promotional';

interface DemoAccount {
  platform: Platform;
  type: SocialAccountType;
  externalId: string;
  name: string;
  handle: string | null;
  /** Followers before the first day, and what they grow per day. */
  followers: number;
  growth: number;
  /** The impressions of an average post over its life, and the share of them that engage. */
  impressions: number;
  engagementRate: number;
  /** After this many hours a post has about two thirds of its impressions. */
  decayHours: number;
  /** How likely a post of a weekday or of the weekend goes out on this account. */
  weekday: number;
  weekend: number;
  /** What the platform reports; everything else stays null, shown as "n. v.". */
  reports: {
    postReach: boolean;
    clicks: boolean;
    saves: boolean;
    accountReach: boolean;
    profileViews: boolean;
  };
}

// Like the mock platforms: X reports no reach, Instagram no clicks, only Instagram saves. The
// accounts of Instagram and Facebook report their own reach, so the overview mixes it with the
// reach of the LinkedIn posts.
const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    platform: 'LINKEDIN',
    type: 'PAGE',
    externalId: 'demo-linkedin-page',
    name: 'Demo GmbH',
    handle: null,
    followers: 1_840,
    growth: 3.5,
    impressions: 1_400,
    engagementRate: 0.045,
    decayHours: 30,
    weekday: 0.65,
    weekend: 0.15,
    reports: { postReach: true, clicks: true, saves: false, accountReach: false, profileViews: true },
  },
  {
    platform: 'INSTAGRAM',
    type: 'BUSINESS',
    externalId: 'demo-instagram-business',
    name: 'Demo GmbH',
    handle: 'demo.gmbh',
    followers: 3_210,
    growth: 5,
    impressions: 1_900,
    engagementRate: 0.055,
    decayHours: 22,
    weekday: 0.55,
    weekend: 0.6,
    reports: { postReach: true, clicks: false, saves: true, accountReach: true, profileViews: true },
  },
  {
    platform: 'FACEBOOK',
    type: 'PAGE',
    externalId: 'demo-facebook-page',
    name: 'Demo GmbH',
    handle: null,
    followers: 2_420,
    growth: 1.5,
    impressions: 900,
    engagementRate: 0.028,
    decayHours: 18,
    weekday: 0.45,
    weekend: 0.35,
    reports: { postReach: true, clicks: true, saves: false, accountReach: true, profileViews: false },
  },
  {
    platform: 'X',
    type: 'PROFILE',
    externalId: 'demo-x-profile',
    name: 'Demo GmbH',
    handle: 'demo_gmbh',
    followers: 1_130,
    growth: 2,
    impressions: 1_600,
    engagementRate: 0.016,
    decayHours: 8,
    weekday: 0.7,
    weekend: 0.4,
    reports: { postReach: false, clicks: true, saves: false, accountReach: false, profileViews: false },
  },
];

interface DemoTopic {
  brief: string;
  text: string;
  style: StyleKey;
}

const DEMO_TOPICS: readonly DemoTopic[] = [
  {
    brief: 'Redaktionsplan für das nächste Quartal',
    text: 'Ein Redaktionsplan spart jede Woche Stunden. So planen Sie die Themen eines ganzen Quartals an einem Nachmittag: Säulen festlegen, Termine setzen, Formate mischen.',
    style: 'professional',
  },
  {
    brief: 'Drei Fehler bei Posts, die Reichweite kosten',
    text: 'Drei Fehler, die Reichweite kosten: eine zu lange Einleitung, keine klare Frage am Ende und ein Link im ersten Satz. So machen Sie es besser.',
    style: 'educational',
  },
  {
    brief: 'Einblick in unser Produktteam',
    text: 'Wie entsteht bei uns eine neue Funktion? Ein Blick hinter die Kulissen: vom ersten Kundengespräch bis zum Release in sechs Wochen.',
    style: 'storytelling',
  },
  {
    brief: 'Kennzahlen, die wirklich zählen',
    text: 'Likes sind nett, aber welche Kennzahlen zeigen echten Erfolg? Engagement-Rate, Klicks und Follower-Zuwachs im Verhältnis zur Reichweite.',
    style: 'thought_leadership',
  },
  {
    brief: 'Kundengeschichte aus dem Maschinenbau',
    text: 'Ein Kunde aus dem Maschinenbau plant seine Posts jetzt in einer Stunde pro Woche und erhält doppelt so viele Anfragen wie vorher.',
    style: 'storytelling',
  },
  {
    brief: 'Die beste Uhrzeit zum Posten',
    text: 'Wann lesen Ihre Kunden? Unsere Auswertung von 500 Posts zeigt: Dienstag und Donnerstag zwischen 8 und 10 Uhr ist die Resonanz am höchsten.',
    style: 'educational',
  },
  {
    brief: 'Neue Funktion: Planung im Kalender',
    text: 'Neu: Ziehen Sie geplante Posts im Kalender einfach auf einen anderen Tag. Die Zeitzone Ihres Workspace bleibt dabei erhalten.',
    style: 'promotional',
  },
  {
    brief: 'Webinar zur Content-Strategie',
    text: 'Am Donnerstag zeigen wir im Webinar, wie aus einem Fachartikel fünf Posts für vier Plattformen werden. Jetzt kostenlos anmelden.',
    style: 'promotional',
  },
  {
    brief: 'Vorstellung des Support-Teams',
    text: 'Unser Support-Team beantwortet jede Anfrage innerhalb eines Werktags. Heute stellen wir die Menschen dahinter vor.',
    style: 'casual',
  },
  {
    brief: 'Checkliste vor dem Veröffentlichen',
    text: 'Vor jedem Post: Rechtschreibung prüfen, Bildrechte klären, Alternativtext ergänzen, Link testen. Die Checkliste zum Speichern.',
    style: 'educational',
  },
  {
    brief: 'Kurzvideos im B2B',
    text: 'Kurzvideos sind längst auch im B2B angekommen. Drei Formate, die ohne großes Budget funktionieren.',
    style: 'thought_leadership',
  },
  {
    brief: 'Rückblick auf die Messe',
    text: 'Danke für die vielen Gespräche an unserem Stand! Die häufigsten Fragen der Besucher und unsere Antworten im Überblick.',
    style: 'casual',
  },
  {
    brief: 'Datenschutz bei Social-Media-Werkzeugen',
    text: 'Wo liegen Ihre Daten? Wir speichern in der EU, verschlüsseln Zugangsdaten und löschen auf Wunsch vollständig. Die Einzelheiten im Überblick.',
    style: 'professional',
  },
];

/** The topic of the n-th post; the topics take turns. */
const topicAt = (position: number): DemoTopic => {
  const topic = DEMO_TOPICS[position % DEMO_TOPICS.length];
  if (!topic) {
    throw new Error('The demo needs topics.');
  }
  return topic;
};

const DEMO_HASHTAGS = ['#Marketing', '#ContentStrategie', '#SocialMedia', '#B2B', '#Mittelstand'];

interface DemoPipelinePost extends DemoTopic {
  status: 'SCHEDULED' | 'DRAFT' | 'FAILED' | 'NEEDS_ATTENTION';
  platforms: readonly Platform[];
  /** The planned day relative to today and the minute of that day; none for a draft. */
  plannedAt: { days: number; minute: number } | null;
  failureCode?: string;
  lastError?: string;
}

/** The posts around today that are not published. */
const DEMO_PIPELINE: readonly DemoPipelinePost[] = [
  {
    brief: 'Ausblick auf das Herbst-Update',
    text: 'Im November erscheint unser Herbst-Update: Auswertungen pro Plattform und ein schnellerer Composer. Ein erster Blick auf die Neuerungen.',
    style: 'promotional',
    status: 'SCHEDULED',
    platforms: ['LINKEDIN', 'X'],
    plannedAt: { days: 1, minute: 9 * 60 },
  },
  {
    brief: 'Fünf Ideen für Posts im Advent',
    text: 'Fünf Ideen für die Adventszeit, die ohne Rabattaktion auskommen: Rückblicke, Einblicke ins Team, Kundenstimmen, Tipps und ein Dankeschön.',
    style: 'educational',
    status: 'SCHEDULED',
    platforms: ['INSTAGRAM', 'FACEBOOK'],
    plannedAt: { days: 2, minute: 12 * 60 + 30 },
  },
  {
    brief: 'Interview mit einer Kundin',
    text: 'Wie plant ein Team aus drei Personen Inhalte für vier Plattformen? Unsere Kundin aus dem Handel erzählt, was sich für sie geändert hat.',
    style: 'storytelling',
    status: 'SCHEDULED',
    platforms: ['LINKEDIN'],
    plannedAt: { days: 4, minute: 8 * 60 + 15 },
  },
  {
    brief: 'Jahresrückblick',
    text: 'Die wichtigsten Zahlen und Momente unseres Jahres, von der ersten Messe bis zum tausendsten Kunden.',
    style: 'casual',
    status: 'DRAFT',
    platforms: ['LINKEDIN', 'INSTAGRAM'],
    plannedAt: null,
  },
  {
    brief: 'Stellenanzeige Content-Marketing',
    text: 'Wir suchen Verstärkung im Content-Marketing: Sie planen Themen, schreiben für vier Plattformen und werten die Ergebnisse aus.',
    style: 'professional',
    status: 'DRAFT',
    platforms: ['LINKEDIN'],
    plannedAt: null,
  },
  {
    brief: 'Hinweis auf die Veranstaltung',
    text: 'Treffen Sie uns am Donnerstag auf dem Marketing-Forum in Köln, Halle 3, Stand 12.',
    style: 'promotional',
    status: 'FAILED',
    platforms: ['INSTAGRAM'],
    plannedAt: { days: -1, minute: 10 * 60 },
    failureCode: 'VALIDATION_REJECTED',
    lastError: 'The mock platform refused the post',
  },
  {
    brief: 'Umfrage zum Einsatz von KI',
    text: 'Setzen Sie KI schon für Ihre Posts ein? Wir sind gespannt auf Ihre Erfahrungen und teilen die Ergebnisse nächste Woche.',
    style: 'thought_leadership',
    status: 'NEEDS_ATTENTION',
    platforms: ['FACEBOOK'],
    plannedAt: { days: -3, minute: 16 * 60 },
    failureCode: 'OUTCOME_UNKNOWN',
    lastError: 'The answer of the platform was lost',
  },
];

/** How a style changes the impressions and the engagement of a post; "none" for posts without. */
const STYLE_EFFECTS: Readonly<Record<StyleKey | 'none', { impressions: number; engagement: number }>> = {
  professional: { impressions: 1, engagement: 0.9 },
  storytelling: { impressions: 1.25, engagement: 1.35 },
  casual: { impressions: 0.9, engagement: 1.2 },
  educational: { impressions: 1.15, engagement: 1.1 },
  thought_leadership: { impressions: 1.1, engagement: 1 },
  promotional: { impressions: 0.8, engagement: 0.7 },
  none: { impressions: 0.95, engagement: 0.95 },
};

/** A pseudo-random sequence in [0, 1) (Park and Miller), the same for the same seed. */
function sequenceOf(seed: number): () => number {
  const modulus = 2_147_483_647;
  let state = seed % modulus;
  return () => {
    state = (state * 48_271) % modulus;
    return (state - 1) / (modulus - 1);
  };
}

/** A date column from YYYY-MM-DD. */
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** The ISO weekday of a day, Monday 1 to Sunday 7. */
const isoWeekdayOf = (day: string): number => ((dateOf(day).getUTCDay() + 6) % 7) + 1;

interface Counters {
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
}

const engagementsOf = (counters: Counters): number | null => {
  const parts = [counters.likes, counters.comments, counters.shares, counters.saves, counters.clicks].filter(
    (value): value is number => value !== null,
  );
  return parts.length === 0 ? null : parts.reduce((sum, value) => sum + value, 0);
};

const scaled = (counters: Counters, share: number): Counters => {
  const part = (value: number | null): number | null => (value === null ? null : Math.round(value * share));
  return {
    impressions: part(counters.impressions),
    reach: part(counters.reach),
    views: part(counters.views),
    likes: part(counters.likes),
    comments: part(counters.comments),
    shares: part(counters.shares),
    clicks: part(counters.clicks),
    saves: part(counters.saves),
  };
};

/** The rows the seed writes, in the order of their foreign keys. */
export interface DemoAnalyticsPlan {
  connections: Prisma.SocialConnectionCreateManyInput[];
  accounts: Prisma.SocialAccountCreateManyInput[];
  posts: Prisma.PostCreateManyInput[];
  variants: Prisma.PostVariantCreateManyInput[];
  snapshots: Prisma.MetricSnapshotCreateManyInput[];
  latest: Prisma.PostMetricLatestCreateManyInput[];
  accountDays: Prisma.AccountMetricSnapshotCreateManyInput[];
}

/** The demo data of a workspace up to `now`, without touching the database. */
export function demoAnalyticsPlan(input: {
  workspaceId: string;
  timeZone: string;
  now: Date;
  ownerId: string | null;
  styleIds: ReadonlyMap<string, string>;
}): DemoAnalyticsPlan {
  const { workspaceId, timeZone, now } = input;
  const random = sequenceOf(20_261_017);
  /** A standard normal value (Box and Muller). */
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const pick = <T>(list: readonly T[]): T => {
    const item = list[Math.floor(random() * list.length)];
    if (item === undefined) {
      throw new Error('pick needs a list with items');
    }
    return item;
  };
  const today = localDayOf(now, timeZone);
  const connectedAt = startOfLocalDay(daysBefore(today, DEMO_ANALYTICS_DAYS + 14), timeZone);
  const plan: DemoAnalyticsPlan = {
    connections: [],
    accounts: [],
    posts: [],
    variants: [],
    snapshots: [],
    latest: [],
    accountDays: [],
  };
  const accounts = DEMO_ACCOUNTS.map((account) => ({
    ...account,
    id: uuidv7(),
    followersNow: account.followers,
  }));
  for (const account of accounts) {
    const connectionId = uuidv7();
    plan.connections.push({
      id: connectionId,
      workspaceId,
      platform: account.platform,
      method: 'MOCK',
      status: 'ACTIVE',
      externalUserId: account.externalId,
      displayName: account.name,
      scopes: [...GRANTED_SCOPES[account.platform]],
      connectedById: input.ownerId,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });
    plan.accounts.push({
      id: account.id,
      workspaceId,
      connectionId,
      platform: account.platform,
      type: account.type,
      externalId: account.externalId,
      name: account.name,
      handle: account.handle,
      connectedById: input.ownerId,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });
  }

  let externalNumber = 0;
  let postingDays = 0;
  // Two posts the platforms no longer know: their polls stopped when they were deleted.
  const deletedVariants = new Set([7, 23]);
  // The 90 local days up to today, so the view of 90 days has no data before it.
  for (let index = 0; index < DEMO_ANALYTICS_DAYS; index += 1) {
    const day = daysBefore(today, DEMO_ANALYTICS_DAYS - 1 - index);
    const weekend = isoWeekdayOf(day) >= 6;
    // The account grows over the period, so the last 30 days beat the 30 before.
    const trend = 0.8 + (0.4 * index) / (DEMO_ANALYTICS_DAYS - 1);
    const postsOfDay = new Map<string, number>();
    // Every weekday has a post and some weekend days. The topics take turns and every ninth post has
    // no style, so the last 30 days hold every style and posts without one, whatever day the seed
    // runs on: the analytics test reads them.
    if (!weekend || random() < 0.3) {
      const topic = topicAt(postingDays);
      const styleKey = postingDays % 9 === 8 ? null : topic.style;
      postingDays += 1;
      const effect = STYLE_EFFECTS[styleKey ?? 'none'];
      const minute = Math.round((7 + random() * 11) * 60);
      const hour = minute / 60;
      const start = startOfLocalDay(day, timeZone).getTime() + minute * MINUTE_MS;
      const chosen = accounts.filter((account) => random() < (weekend ? account.weekend : account.weekday));
      if (chosen.length === 0) {
        chosen.push(pick(accounts));
      }
      // Today only what has gone out by now.
      const targets = chosen.filter((_, position) => start + position * 3 * MINUTE_MS < now.getTime());
      const postId = uuidv7();
      const createdAt = new Date(start - 2 * 24 * HOUR_MS);
      if (targets.length > 0) {
        plan.posts.push({
          id: postId,
          workspaceId,
          brief: topic.brief,
          language: 'de',
          styleId: styleKey ? (input.styleIds.get(styleKey) ?? null) : null,
          createdById: input.ownerId,
          version: 1,
          createdAt,
          updatedAt: new Date(start),
        });
      }
      targets.forEach((account, position) => {
        externalNumber += 1;
        const variantId = uuidv7();
        const publishedAt = new Date(start + position * 3 * MINUTE_MS);
        const externalPostId = `demo-${account.platform.toLowerCase()}-${String(externalNumber)}`;
        const deletedAt = deletedVariants.has(externalNumber)
          ? new Date(publishedAt.getTime() + 100 * HOUR_MS)
          : null;
        // The life of the post: what it reaches in the end, before the cascade samples it.
        const goodTime = hour < 10 || hour >= 17 ? 1.1 : 1;
        const impressions =
          account.impressions *
          effect.impressions *
          goodTime *
          (weekend ? 0.75 : 1) *
          trend *
          Math.exp(0.35 * normal());
        const engagements =
          impressions * account.engagementRate * effect.engagement * Math.exp(0.25 * normal());
        const total: Counters = {
          impressions,
          reach: account.reports.postReach ? impressions * (0.72 + 0.1 * random()) : null,
          views: null,
          likes: engagements * 0.6,
          comments: engagements * 0.1,
          shares: engagements * 0.08,
          clicks: account.reports.clicks ? engagements * 0.22 : null,
          saves: account.reports.saves ? engagements * 0.22 : null,
        };
        let step = 0;
        let last: { capturedAt: Date; counters: Counters } | null = null;
        for (const hours of cadenceHours(account.platform, 'MOCK')) {
          const capturedAt = new Date(
            publishedAt.getTime() + hours * HOUR_MS + (2 + Math.floor(random() * 8)) * MINUTE_MS,
          );
          if (capturedAt >= now || (deletedAt && capturedAt >= deletedAt)) {
            break;
          }
          const counters = scaled(total, 1 - Math.exp(-hours / account.decayHours));
          plan.snapshots.push({
            id: uuidv7(),
            workspaceId,
            variantId,
            socialAccountId: account.id,
            platform: account.platform,
            step,
            ...counters,
            raw: { mock: { ...counters } },
            mappingVersion: MOCK_MAP_VERSION,
            capturedAt,
          });
          last = { capturedAt, counters };
          step += 1;
        }
        const hashtags =
          account.platform === 'INSTAGRAM' || account.platform === 'X'
            ? [pick(DEMO_HASHTAGS), pick(DEMO_HASHTAGS)].filter((tag, at, list) => list.indexOf(tag) === at)
            : [];
        plan.variants.push({
          id: variantId,
          workspaceId,
          postId,
          socialAccountId: account.id,
          platform: account.platform,
          targetKey: `t${String(position + 1)}`,
          text: topic.text,
          hashtags,
          status: 'PUBLISHED',
          scheduledAt: publishedAt,
          scheduledTimezone: timeZone,
          scheduleVersion: 1,
          version: 2,
          publishedAt,
          externalPostId,
          externalUrl: `https://mock.${account.platform.toLowerCase()}.example/posts/${externalPostId}`,
          metricsStep: step,
          metricsNextAt: null,
          externalDeletedAt: deletedAt,
          createdAt,
          updatedAt: deletedAt ?? publishedAt,
        });
        if (last) {
          plan.latest.push({
            variantId,
            workspaceId,
            socialAccountId: account.id,
            platform: account.platform,
            publishedAt,
            capturedAt: last.capturedAt,
            ...last.counters,
            engagements: engagementsOf(last.counters),
          });
        }
        postsOfDay.set(account.id, (postsOfDay.get(account.id) ?? 0) + 1);
      });
    }

    // The daily numbers of each account, polled around 03:15 on the next morning.
    const capturedAt = new Date(startOfLocalDay(nextDay(day), timeZone).getTime() + 195 * MINUTE_MS);
    for (const account of accounts) {
      const posts = postsOfDay.get(account.id) ?? 0;
      const churn = random() < 0.08 ? 2.5 * account.growth : 0;
      account.followersNow += Math.round(
        account.growth * (0.4 + 1.2 * random()) + posts * account.growth * 1.5 - churn,
      );
      if (capturedAt >= now) {
        continue;
      }
      const followers = account.followersNow;
      const reach = account.reports.accountReach
        ? Math.round(followers * (0.1 + 0.08 * random()) + posts * account.impressions * 0.45)
        : null;
      const profileViews = account.reports.profileViews
        ? Math.round(followers * (0.01 + 0.015 * random()) + posts * 12)
        : null;
      plan.accountDays.push({
        id: uuidv7(),
        workspaceId,
        socialAccountId: account.id,
        platform: account.platform,
        day: dateOf(day),
        followers,
        reach,
        profileViews,
        raw: { mock: { followers, reach, profileViews } },
        mappingVersion: MOCK_MAP_VERSION,
        capturedAt,
      });
    }
  }

  for (const item of DEMO_PIPELINE) {
    const postId = uuidv7();
    const plannedAt = item.plannedAt
      ? new Date(
          startOfLocalDay(daysBefore(today, -item.plannedAt.days), timeZone).getTime() +
            item.plannedAt.minute * MINUTE_MS,
        )
      : null;
    const createdAt = new Date(Math.min(now.getTime(), plannedAt?.getTime() ?? now.getTime()) - 26 * HOUR_MS);
    const updatedAt = new Date(createdAt.getTime() + 2 * HOUR_MS);
    plan.posts.push({
      id: postId,
      workspaceId,
      brief: item.brief,
      language: 'de',
      styleId: input.styleIds.get(item.style) ?? null,
      createdById: input.ownerId,
      version: 1,
      createdAt,
      updatedAt,
    });
    item.platforms.forEach((platform, position) => {
      const account = accounts.find((candidate) => candidate.platform === platform);
      plan.variants.push({
        id: uuidv7(),
        workspaceId,
        postId,
        socialAccountId: account?.id ?? null,
        platform,
        targetKey: `t${String(position + 1)}`,
        text: item.text,
        status: item.status,
        scheduledAt: plannedAt,
        scheduledTimezone: plannedAt ? timeZone : null,
        scheduleVersion: plannedAt ? 1 : 0,
        version: plannedAt ? 1 : 0,
        failureCode: item.failureCode ?? null,
        lastError: item.lastError ?? null,
        createdAt,
        updatedAt,
      });
    });
  }
  return plan;
}

export interface DemoAnalyticsResult {
  /** False when the demo accounts were there already; the days are rolled up again anyway. */
  created: boolean;
  accounts: number;
  /** The published variants of the demo accounts. */
  published: number;
}

/**
 * Writes the demo analytics into the demo workspace, relative to `now`. When its accounts exist,
 * it only rolls the days up again, which changes nothing. Needs the client of app_system, like
 * seedDemoData.
 */
export async function seedDemoAnalytics(
  prisma: PrismaClient,
  demo: DemoSeedResult,
  now: Date,
): Promise<DemoAnalyticsResult> {
  const { workspaceId, organizationId } = demo;
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  const externalIds = DEMO_ACCOUNTS.map((account) => account.externalId);
  const existing = await prisma.socialAccount.count({
    where: { workspaceId, externalId: { in: externalIds } },
  });
  const created = existing === 0;
  if (created) {
    const owner = DEMO_USERS.find((user) => user.role === 'OWNER');
    const presets = await prisma.postStyle.findMany({
      where: { workspaceId: null },
      select: { id: true, key: true },
    });
    const plan = demoAnalyticsPlan({
      workspaceId,
      timeZone: workspace.timezone,
      now,
      ownerId: owner ? (demo.userIds[owner.email] ?? null) : null,
      styleIds: new Map(presets.map((style) => [style.key, style.id])),
    });
    await prisma.$transaction(
      async (tx) => {
        await tx.socialConnection.createMany({ data: plan.connections });
        await tx.socialAccount.createMany({ data: plan.accounts });
        await tx.post.createMany({ data: plan.posts });
        await tx.postVariant.createMany({ data: plan.variants });
        await tx.metricSnapshot.createMany({ data: plan.snapshots });
        await tx.postMetricLatest.createMany({ data: plan.latest });
        await tx.accountMetricSnapshot.createMany({ data: plan.accountDays });
      },
      { timeout: 60_000 },
    );
  }
  const today = localDayOf(now, workspace.timezone);
  await new PrismaAnalyticsUnitOfWork(prisma).run({ organizationId, workspaceId }, (store) =>
    store.rollups.rollUp(workspaceId, daysBefore(today, DEMO_ANALYTICS_DAYS - 1), today),
  );
  const published = await prisma.postVariant.count({
    where: { workspaceId, status: 'PUBLISHED', socialAccount: { externalId: { in: externalIds } } },
  });
  return { created, accounts: DEMO_ACCOUNTS.length, published };
}
