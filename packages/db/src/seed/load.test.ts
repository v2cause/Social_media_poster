import { describe, expect, it } from 'vitest';

import {
  loadFixtureOptionsSchema,
  loadWorkspacePlan,
  mergeLoadRows,
  type LoadFixtureOptions,
  type LoadRows,
} from './load';

// The data of the load test (guide step 8.5): every workspace of a run has its owner, four mock
// accounts with the latency of the run and an image with a rendition per platform. Its posts
// fall due in the minute of the run, a variant on every account, each with the image.

const OPTIONS: LoadFixtureOptions = {
  run: 'r1',
  organizations: 3,
  duePostsPerWorkspace: 2,
  dueAt: new Date('2026-10-19T09:00:00Z'),
  spreadSeconds: 0,
  latencyMs: 500,
  now: new Date('2026-10-19T08:55:00Z'),
};
const MINUTE_MS = 60_000;

const planOf = (index: number, options: LoadFixtureOptions = OPTIONS) =>
  loadWorkspacePlan({ options, index, passwordHash: 'scrypt$hash', styleIds: new Map() });

/** The single row of a table. */
const only = <T>(rows: readonly T[]): T => {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`expected one row, got ${String(rows.length)}`);
  }
  return row;
};

const timeOf = (value: Date | string | null | undefined): number =>
  value === null || value === undefined ? Number.NaN : new Date(value).getTime();

/** The variants due in the minute of the run; the history plans its posts days ahead. */
const dueOf = (rows: LoadRows, options: LoadFixtureOptions = OPTIONS) =>
  rows.variants.filter((variant) => {
    const at = timeOf(variant.scheduledAt);
    return at >= options.dueAt.getTime() && at < options.dueAt.getTime() + MINUTE_MS;
  });

describe('the data of the load test', () => {
  it('give every workspace its owner, who signs in with the password of the run', () => {
    const { workspace, rows } = planOf(0);

    expect(workspace.slug).toBe('load-r1-1');
    expect(workspace.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(workspace.email).toBe('owner.1.r1@load.test');
    const user = only(rows.users);
    expect(user).toMatchObject({ email: workspace.email, emailVerified: true });
    expect(only(rows.credentials)).toMatchObject({
      userId: user.id,
      providerId: 'credential',
      password: 'scrypt$hash',
    });
    expect(only(rows.memberships)).toMatchObject({ userId: user.id, role: 'OWNER' });
    expect(only(rows.subscriptions)).toMatchObject({ planKey: 'agency', status: 'ACTIVE' });
    expect(only(rows.workspaces)).toMatchObject({ slug: workspace.slug, timezone: 'Europe/Berlin' });
  });

  it('put a variant of every due post on each of the four mock accounts, with the latency of the run', () => {
    const { workspace, rows } = planOf(1);
    const due = dueOf(rows);

    expect(rows.accounts.map((account) => account.platform).sort()).toEqual([
      'FACEBOOK',
      'INSTAGRAM',
      'LINKEDIN',
      'X',
    ]);
    expect(rows.accounts.map((account) => account.settings)).toEqual(
      Array.from({ length: 4 }, () => ({ latencyMs: 500 })),
    );
    expect(rows.connections.every((connection) => connection.method === 'MOCK')).toBe(true);
    expect(due).toHaveLength(8);
    expect(workspace.dueVariants).toBe(8);
    for (const variant of due) {
      const account = rows.accounts.find((candidate) => candidate.id === variant.socialAccountId);
      expect(account?.platform).toBe(variant.platform);
      expect(variant).toMatchObject({ status: 'SCHEDULED', scheduleVersion: 1 });
      // Within the 280 characters of X.
      expect(variant.text?.length).toBeLessThanOrEqual(280);
    }
    expect(new Set(due.map((variant) => variant.postId)).size).toBe(2);
  });

  it('let every due post fall due at the start of the minute without a spread', () => {
    const due = [0, 1, 2].flatMap((index) => dueOf(planOf(index).rows));

    expect(due).toHaveLength(24);
    expect(new Set(due.map((variant) => timeOf(variant.scheduledAt)))).toEqual(
      new Set([OPTIONS.dueAt.getTime()]),
    );
  });

  it('spread the due posts evenly over the seconds, the workspaces taking turns', () => {
    const spread = { ...OPTIONS, spreadSeconds: 30 };
    const secondsOf = (index: number): number[] =>
      [...new Set(dueOf(planOf(index, spread).rows, spread).map((variant) => timeOf(variant.scheduledAt)))]
        .map((at) => (at - OPTIONS.dueAt.getTime()) / 1000)
        .sort((a, b) => a - b);

    // Six posts in 30 seconds: slot p * 3 + index starts 5 seconds after the one before.
    expect(secondsOf(0)).toEqual([0, 15]);
    expect(secondsOf(1)).toEqual([5, 20]);
    expect(secondsOf(2)).toEqual([10, 25]);
  });

  it('attach the image to every due variant, with a rendition for each platform', () => {
    const { rows } = planOf(0);
    const asset = only(rows.assets);
    const due = dueOf(rows);

    expect(asset).toMatchObject({ status: 'READY', mimeType: 'image/jpeg', width: 1600, height: 1200 });
    expect(rows.postMedia.map((item) => item.variantId).sort()).toEqual(
      due.map((variant) => variant.id).sort(),
    );
    expect(rows.postMedia.every((item) => item.assetId === asset.id && item.position === 0)).toBe(true);
    expect(
      rows.renditions.map((rendition) => [
        rendition.profile,
        rendition.width,
        rendition.height,
        rendition.cropHash,
      ]),
    ).toEqual([
      ['linkedin_image', 1600, 1200, 'full'],
      ['instagram_feed', 1080, 810, 'full'],
      ['facebook_photo', 1600, 1200, 'full'],
      ['x_image', 1600, 1200, 'full'],
      ['thumb_320', 320, 240, 'full'],
      ['thumb_640', 640, 480, 'full'],
    ]);
    for (const rendition of rows.renditions) {
      expect(rendition.storageKey.startsWith(`ws/${asset.workspaceId}/assets/${String(asset.id)}/`)).toBe(
        true,
      );
    }
  });

  it('name posts for the composer and keep the rows of two workspaces apart', () => {
    const first = planOf(0);
    const second = planOf(1);
    const postIds = new Set(first.rows.posts.map((post) => post.id));

    expect(first.workspace.postIds).toHaveLength(5);
    expect(first.workspace.postIds.every((id) => postIds.has(id))).toBe(true);
    expect(
      second.rows.variants.some((variant) => first.rows.variants.some((other) => other.id === variant.id)),
    ).toBe(false);
    expect(second.workspace.slug).not.toBe(first.workspace.slug);
    expect(second.workspace.email).not.toBe(first.workspace.email);
  });

  it('join the rows of several workspaces table by table', () => {
    const first = planOf(0).rows;
    const second = planOf(1).rows;
    const merged = mergeLoadRows([first, second]);

    expect(merged.users).toHaveLength(2);
    expect(merged.variants).toHaveLength(first.variants.length + second.variants.length);
    expect(merged.snapshots).toHaveLength(first.snapshots.length + second.snapshots.length);
  });

  it('refuse a run id, a size or a spread out of range', () => {
    expect(loadFixtureOptionsSchema.safeParse(OPTIONS).success).toBe(true);
    for (const wrong of [
      { run: 'Load-1' },
      { run: '' },
      { organizations: 0 },
      { duePostsPerWorkspace: 101 },
      { spreadSeconds: 60 },
      { latencyMs: -1 },
    ]) {
      expect(
        loadFixtureOptionsSchema.safeParse({ ...OPTIONS, ...wrong }).success,
        JSON.stringify(wrong),
      ).toBe(false);
    }
  });
});
