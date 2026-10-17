import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  accountMetricsJobId,
  gdprJobId,
  jobIdOf,
  mediaProcessJobId,
  mediaRenderJobId,
  notifyEmailJobId,
  notifyJobId,
  postMetricsJobId,
  publishDeadLetterId,
  publishJobId,
  rollupKey,
  stripeJobId,
  tokenRefreshJobId,
  usageReportJobId,
  xbJobId,
} from './index';

// Guide step 4.3: job ids come from builders only, and BullMQ refuses ids with ":".

const id = randomUUID();

describe('job ids', () => {
  it('builds every id without ":" in the documented form', () => {
    const ids = [
      publishJobId(id, 3),
      publishDeadLetterId(id, 3),
      tokenRefreshJobId(id),
      postMetricsJobId(id, '202610161500'),
      accountMetricsJobId(id, '2026-10-16'),
      rollupKey(id, '2026-09-11', '2026-10-16'),
      notifyJobId(id),
      notifyEmailJobId(id, id),
      stripeJobId('evt_1Abc'),
      usageReportJobId(id, '2026-10-17'),
      gdprJobId(id),
      mediaProcessJobId(id),
      mediaRenderJobId({ assetId: id, profile: 'instagram_feed', cropHash: 'x0y120w1080h1350-lb' }),
      ...['publish', 'metrics', 'login.start'].map((operation) => xbJobId(operation, id, id)),
    ];

    for (const jobId of ids) {
      expect(jobId).not.toContain(':');
      expect(jobId).not.toMatch(/\s/);
    }
    expect(publishJobId(id, 3)).toBe(`pub.${id}.3`);
    expect(publishDeadLetterId(id, 3)).toBe(`dead.pub.${id}.3`);
    expect(tokenRefreshJobId(id)).toBe(`tok.${id}`);
    expect(postMetricsJobId(id, 'b1')).toBe(`mp.${id}.b1`);
    expect(accountMetricsJobId(id, '2026-10-16')).toBe(`ma.${id}.2026-10-16`);
    expect(rollupKey(id, '2026-10-15', '2026-10-16')).toBe(`ru.${id}.2026-10-15.2026-10-16`);
    expect(notifyJobId(id)).toBe(`ntf.${id}`);
    expect(notifyEmailJobId(id, 'u1')).toBe(`ntf.${id}.u1`);
    expect(usageReportJobId(id, '2026-10-17')).toBe(`usage.${id}.2026-10-17`);
    expect(xbJobId('login.start', id, 1)).toBe(`xb.login.start.${id}.1`);
  });

  it('refuses parts that would break an id', () => {
    expect(() => jobIdOf('pub', 'a:b', 1)).toThrow(RangeError);
    expect(() => jobIdOf('pub', '', 1)).toThrow(RangeError);
    expect(() => jobIdOf('pub', 'a b')).toThrow(RangeError);
    expect(() => stripeJobId('evt:1')).toThrow(RangeError);
  });
});
