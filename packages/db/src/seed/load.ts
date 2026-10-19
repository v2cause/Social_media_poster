import { createHash } from 'node:crypto';

import { cropHashOf, daysBefore, localDayOf, originalKey, renditionKey } from '@smp/core';
import { hashPassword } from '@smp/crypto';
import {
  PLATFORMS,
  planRendition,
  RENDITION_PROFILES,
  renditionProfileFor,
  type RenditionProfile,
} from '@smp/platform-rules';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { PrismaAnalyticsUnitOfWork } from '../analytics/prisma-analytics-unit-of-work';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { DEMO_ANALYTICS_DAYS, demoAnalyticsPlan } from './demo-analytics';
import { CREDENTIAL_PROVIDER } from './demo';

// The data of the load test (guide step 8.5, ADR 0041): organizations with one workspace and its
// owner each. Every workspace gets the demo history of 90 days, so that the reads of the test
// meet realistic amounts, an image with its renditions, and posts due in the same minute on all
// four of its mock accounts, each variant with the image. The mock platforms wait latencyMs on
// every call, as a platform takes time to answer; the drills of the runbooks (guide step 8.7) let
// the accounts of one platform fail. Never in production; needs app_system.

/** The options of one run; the tool of the load test checks its arguments with this schema. */
export const loadFixtureOptionsSchema = z.object({
  /** Part of every slug and address, so that the rows of a run can be told apart. */
  run: z.string().regex(/^[a-z0-9]{1,8}$/),
  organizations: z.number().int().min(1).max(2_000),
  /** Posts per workspace that fall due, each with a variant on every account of the workspace. */
  duePostsPerWorkspace: z.number().int().min(1).max(100),
  /** When the first post falls due; the others follow evenly within spreadSeconds. */
  dueAt: z.date(),
  spreadSeconds: z.number().int().min(0).max(59),
  /** What every call of the mock platforms waits. */
  latencyMs: z.number().int().min(0).max(120_000),
  /** More settings of the mock accounts of one platform, such as a failure until a time. */
  failure: z.object({ platform: z.enum(PLATFORMS), settings: z.record(z.string(), z.json()) }).optional(),
  now: z.date(),
});
export type LoadFixtureOptions = z.infer<typeof loadFixtureOptionsSchema>;

/** What the k6 script needs of a workspace; the password comes from SEED_USER_PASSWORD. */
export interface LoadWorkspace {
  slug: string;
  email: string;
  /** Posts to open in the composer: some of the history and the first due one. */
  postIds: string[];
  dueVariants: number;
}

/** The description of a run that the k6 script reads. */
export interface LoadFixture {
  run: string;
  dueAt: string;
  spreadSeconds: number;
  dueVariants: number;
  workspaces: LoadWorkspace[];
}

/** The rows of the fixture, in the order of their foreign keys. */
export interface LoadRows {
  users: Prisma.UserCreateManyInput[];
  credentials: Prisma.AccountCreateManyInput[];
  organizations: Prisma.OrganizationCreateManyInput[];
  workspaces: Prisma.WorkspaceCreateManyInput[];
  settings: Prisma.WorkspaceSettingsCreateManyInput[];
  memberships: Prisma.MembershipCreateManyInput[];
  subscriptions: Prisma.SubscriptionCreateManyInput[];
  connections: Prisma.SocialConnectionCreateManyInput[];
  accounts: Prisma.SocialAccountCreateManyInput[];
  assets: Prisma.MediaAssetCreateManyInput[];
  renditions: Prisma.MediaRenditionCreateManyInput[];
  posts: Prisma.PostCreateManyInput[];
  variants: Prisma.PostVariantCreateManyInput[];
  postMedia: Prisma.PostMediaCreateManyInput[];
  snapshots: Prisma.MetricSnapshotCreateManyInput[];
  latest: Prisma.PostMetricLatestCreateManyInput[];
  accountDays: Prisma.AccountMetricSnapshotCreateManyInput[];
}

export const LOAD_TIME_ZONE = 'Europe/Berlin';
/** The posts of the history a workspace names for the composer reads. */
const COMPOSER_POSTS = 4;
/** The image of the due posts, as the media pipeline would have measured it. */
const IMAGE = { width: 1600, height: 1200, sizeBytes: 412_000 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const slugOf = (run: string, index: number): string => `load-${run}-${String(index + 1)}`;
const emailOf = (run: string, index: number): string => `owner.${String(index + 1)}.${run}@load.test`;

/** The profiles a published image needs (one per platform) and the thumbnails of the library. */
const PROFILES: readonly RenditionProfile[] = [
  ...(['LINKEDIN', 'INSTAGRAM', 'FACEBOOK', 'X'] as const).map(renditionProfileFor),
  RENDITION_PROFILES.thumb_320,
  RENDITION_PROFILES.thumb_640,
];

/** The image of a workspace with its renditions, as the media pipeline leaves it. */
function imageOf(
  workspaceId: string,
  ownerId: string,
  createdAt: Date,
): {
  asset: Prisma.MediaAssetCreateManyInput & { id: string };
  renditions: Prisma.MediaRenditionCreateManyInput[];
} {
  const assetId = uuidv7();
  const renditions = PROFILES.map((profile): Prisma.MediaRenditionCreateManyInput => {
    const planned = planRendition(IMAGE, { crop: null, letterbox: false }, profile);
    if (!planned.ok) {
      throw new Error(`The load image does not fit the profile ${profile.key}: ${planned.issue}`);
    }
    const cropHash = cropHashOf(null, false);
    const { width, height } = planned.plan;
    return {
      id: uuidv7(),
      workspaceId,
      assetId,
      profile: profile.key,
      cropHash,
      storageKey: renditionKey(workspaceId, assetId, {
        profile: profile.key,
        cropHash,
        extension: profile.format === 'jpeg' ? 'jpg' : profile.format,
      }),
      mimeType: `image/${profile.format}`,
      width,
      height,
      sizeBytes: Math.round((IMAGE.sizeBytes * width * height) / (IMAGE.width * IMAGE.height)),
      createdAt,
    };
  });
  return {
    asset: {
      id: assetId,
      workspaceId,
      status: 'READY',
      fileName: 'wochenplan.jpg',
      declaredMimeType: 'image/jpeg',
      declaredSize: IMAGE.sizeBytes,
      storageKey: originalKey(workspaceId, assetId),
      mimeType: 'image/jpeg',
      sizeBytes: IMAGE.sizeBytes,
      width: IMAGE.width,
      height: IMAGE.height,
      sha256: createHash('sha256').update(assetId).digest('hex'),
      altText: 'Ein Wochenplan mit Beiträgen für vier Netzwerke',
      uploadedById: ownerId,
      version: 1,
      processedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    },
    renditions,
  };
}

/**
 * The rows of workspace `index` of a run, without touching the database. Post `p` of the
 * workspace falls due in slot p * organizations + index of all due posts, so that the
 * workspaces take turns when the due times spread over several seconds.
 */
export function loadWorkspacePlan(input: {
  options: LoadFixtureOptions;
  index: number;
  passwordHash: string;
  /** The ids of the preset styles by key, for the history. */
  styleIds: ReadonlyMap<string, string>;
}): { workspace: LoadWorkspace; organizationId: string; workspaceId: string; rows: LoadRows } {
  const { options, index } = input;
  const { run, now } = options;
  const userId = uuidv7();
  const organizationId = uuidv7();
  const workspaceId = uuidv7();
  const slug = slugOf(run, index);
  const email = emailOf(run, index);
  const createdAt = new Date(now.getTime() - 120 * DAY_MS);

  const history = demoAnalyticsPlan({
    workspaceId,
    timeZone: LOAD_TIME_ZONE,
    now,
    ownerId: userId,
    styleIds: input.styleIds,
  });
  const accounts = history.accounts.map((account) => ({
    ...account,
    settings: {
      latencyMs: options.latencyMs,
      ...(account.platform === options.failure?.platform ? options.failure.settings : {}),
    },
  }));
  const image = imageOf(workspaceId, userId, createdAt);

  const totalPosts = options.organizations * options.duePostsPerWorkspace;
  const spreadMs = options.spreadSeconds * 1000;
  const duePosts: Prisma.PostCreateManyInput[] = [];
  const dueVariants: Prisma.PostVariantCreateManyInput[] = [];
  const postMedia: Prisma.PostMediaCreateManyInput[] = [];
  const plannedAt = new Date(now.getTime() - DAY_MS);
  for (let post = 0; post < options.duePostsPerWorkspace; post += 1) {
    const postId = uuidv7();
    const slot = post * options.organizations + index;
    const scheduledAt = new Date(options.dueAt.getTime() + Math.floor((slot * spreadMs) / totalPosts));
    duePosts.push({
      id: postId,
      workspaceId,
      brief: 'Lasttest',
      language: 'de',
      createdById: userId,
      version: 1,
      createdAt: plannedAt,
      updatedAt: plannedAt,
    });
    accounts.forEach((account, position) => {
      const variantId = uuidv7();
      dueVariants.push({
        id: variantId,
        workspaceId,
        postId,
        socialAccountId: account.id,
        platform: account.platform,
        targetKey: `t${String(position + 1)}`,
        text: `Lasttest ${run}, Beitrag ${String(post + 1)}: So plant ein Team seine Woche in vier Netzwerken.`,
        status: 'SCHEDULED',
        scheduledAt,
        scheduledTimezone: LOAD_TIME_ZONE,
        scheduleVersion: 1,
        version: 1,
        createdAt: plannedAt,
        updatedAt: plannedAt,
      });
      postMedia.push({
        id: uuidv7(),
        workspaceId,
        variantId,
        assetId: image.asset.id,
        position: 0,
        createdAt: plannedAt,
        updatedAt: plannedAt,
      });
    });
  }

  const composerPosts = history.posts.slice(0, COMPOSER_POSTS).flatMap((post) => (post.id ? [post.id] : []));
  const firstDue = duePosts[0]?.id;
  return {
    organizationId,
    workspaceId,
    workspace: {
      slug,
      email,
      postIds: firstDue ? [...composerPosts, firstDue] : composerPosts,
      dueVariants: dueVariants.length,
    },
    rows: {
      users: [
        {
          id: userId,
          email,
          name: `Lasttest ${String(index + 1)}`,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        },
      ],
      credentials: [
        {
          id: uuidv7(),
          userId,
          accountId: userId,
          providerId: CREDENTIAL_PROVIDER,
          password: input.passwordHash,
          createdAt,
          updatedAt: createdAt,
        },
      ],
      organizations: [
        { id: organizationId, name: `Lasttest ${run} ${String(index + 1)}`, createdAt, updatedAt: createdAt },
      ],
      workspaces: [
        {
          id: workspaceId,
          organizationId,
          slug,
          name: `Lasttest ${String(index + 1)}`,
          timezone: LOAD_TIME_ZONE,
          contentLanguage: 'de',
          industry: 'Software',
          targetAudience: 'Marketing-Teams im Mittelstand',
          contentPillars: ['Produkt', 'Einblicke', 'Tipps'],
          createdAt,
          updatedAt: createdAt,
        },
      ],
      settings: [{ workspaceId }],
      memberships: [{ id: uuidv7(), organizationId, userId, role: 'OWNER', createdAt, updatedAt: createdAt }],
      // The largest plan without Stripe, like the demo organization.
      subscriptions: [
        { organizationId, planKey: 'agency', status: 'ACTIVE', createdAt, updatedAt: createdAt },
      ],
      connections: history.connections,
      accounts,
      assets: [image.asset],
      renditions: image.renditions,
      posts: [...history.posts, ...duePosts],
      variants: [...history.variants, ...dueVariants],
      postMedia,
      snapshots: history.snapshots,
      latest: history.latest,
      accountDays: history.accountDays,
    },
  };
}

/** The rows of several workspaces in one set, table by table. */
export function mergeLoadRows(parts: readonly LoadRows[]): LoadRows {
  const merged: LoadRows = {
    users: [],
    credentials: [],
    organizations: [],
    workspaces: [],
    settings: [],
    memberships: [],
    subscriptions: [],
    connections: [],
    accounts: [],
    assets: [],
    renditions: [],
    posts: [],
    variants: [],
    postMedia: [],
    snapshots: [],
    latest: [],
    accountDays: [],
  };
  for (const part of parts) {
    for (const table of Object.keys(merged) as (keyof LoadRows)[]) {
      // Each table keeps its own row type; the cast only joins arrays of the same table.
      (merged[table] as unknown[]).push(...part[table]);
    }
  }
  return merged;
}

/** Workspaces per transaction: about 30,000 rows. */
const WORKSPACES_PER_TRANSACTION = 20;

/**
 * Writes the fixture of a run and rolls up the analytics of its workspaces; the users sign in
 * with `password`. A run id that is in use already is refused. Needs the client of app_system,
 * like the demo seed.
 */
export async function seedLoadFixture(
  prisma: PrismaClient,
  input: LoadFixtureOptions,
  password: string,
  progress: (written: number) => void = () => undefined,
): Promise<LoadFixture> {
  const options = loadFixtureOptionsSchema.parse(input);
  const taken = await prisma.workspace.count({ where: { slug: { startsWith: `load-${options.run}-` } } });
  if (taken > 0) {
    throw new Error(`The run ${options.run} has written its data already; choose another run id.`);
  }
  const passwordHash = await hashPassword(password);
  const presets = await prisma.postStyle.findMany({
    where: { workspaceId: null },
    select: { id: true, key: true },
  });
  const styleIds = new Map(presets.map((style) => [style.key, style.id]));

  const fixture: LoadFixture = {
    run: options.run,
    dueAt: options.dueAt.toISOString(),
    spreadSeconds: options.spreadSeconds,
    dueVariants: 0,
    workspaces: [],
  };
  const scopes: { organizationId: string; workspaceId: string }[] = [];
  for (let start = 0; start < options.organizations; start += WORKSPACES_PER_TRANSACTION) {
    const end = Math.min(options.organizations, start + WORKSPACES_PER_TRANSACTION);
    const plans = Array.from({ length: end - start }, (_, offset) =>
      loadWorkspacePlan({ options, index: start + offset, passwordHash, styleIds }),
    );
    const rows = mergeLoadRows(plans.map((plan) => plan.rows));
    await prisma.$transaction(
      async (tx) => {
        await tx.user.createMany({ data: rows.users });
        await tx.account.createMany({ data: rows.credentials });
        await tx.organization.createMany({ data: rows.organizations });
        await tx.workspace.createMany({ data: rows.workspaces });
        await tx.workspaceSettings.createMany({ data: rows.settings });
        await tx.membership.createMany({ data: rows.memberships });
        await tx.subscription.createMany({ data: rows.subscriptions });
        await tx.socialConnection.createMany({ data: rows.connections });
        await tx.socialAccount.createMany({ data: rows.accounts });
        await tx.mediaAsset.createMany({ data: rows.assets });
        await tx.mediaRendition.createMany({ data: rows.renditions });
        await tx.post.createMany({ data: rows.posts });
        await tx.postVariant.createMany({ data: rows.variants });
        await tx.postMedia.createMany({ data: rows.postMedia });
        await tx.metricSnapshot.createMany({ data: rows.snapshots });
        await tx.postMetricLatest.createMany({ data: rows.latest });
        await tx.accountMetricSnapshot.createMany({ data: rows.accountDays });
      },
      { timeout: 120_000 },
    );
    for (const plan of plans) {
      fixture.workspaces.push(plan.workspace);
      fixture.dueVariants += plan.workspace.dueVariants;
      scopes.push({ organizationId: plan.organizationId, workspaceId: plan.workspaceId });
    }
    progress(end);
  }

  // The dashboards read the rollups, as they do after the nightly run.
  const today = localDayOf(options.now, LOAD_TIME_ZONE);
  const analytics = new PrismaAnalyticsUnitOfWork(prisma);
  for (const scope of scopes) {
    await analytics.run(scope, (store) =>
      store.rollups.rollUp(scope.workspaceId, daysBefore(today, DEMO_ANALYTICS_DAYS - 1), today),
    );
  }
  return fixture;
}
