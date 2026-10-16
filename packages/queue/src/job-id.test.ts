import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  gdprJobId,
  jobIdOf,
  mediaProcessJobId,
  mediaRenderJobId,
  notifyJobId,
  postMetricsJobId,
  publishJobId,
  stripeJobId,
  tokenRefreshJobId,
  XB_OPERATIONS,
  xbJobId,
} from './index';

// Guide step 4.3: job ids come from builders only, and BullMQ refuses ids with ":".

const id = randomUUID();

describe('job ids', () => {
  it('builds every id without ":" in the documented form', () => {
    const ids = [
      publishJobId(id, 3),
      tokenRefreshJobId(id),
      postMetricsJobId(id, '202610161500'),
      notifyJobId(id),
      stripeJobId('evt_1Abc'),
      gdprJobId(id),
      mediaProcessJobId(id),
      mediaRenderJobId({ assetId: id, profile: 'instagram_feed', cropHash: 'x0y120w1080h1350-lb' }),
      ...XB_OPERATIONS.map((operation) => xbJobId(operation, id, 2)),
    ];

    for (const jobId of ids) {
      expect(jobId).not.toContain(':');
      expect(jobId).not.toMatch(/\s/);
    }
    expect(publishJobId(id, 3)).toBe(`pub.${id}.3`);
    expect(tokenRefreshJobId(id)).toBe(`tok.${id}`);
    expect(postMetricsJobId(id, 'b1')).toBe(`mp.${id}.b1`);
    expect(notifyJobId(id)).toBe(`ntf.${id}`);
    expect(xbJobId('login.start', id, 1)).toBe(`xb.login.start.${id}.1`);
  });

  it('refuses parts that would break an id', () => {
    expect(() => jobIdOf('pub', 'a:b', 1)).toThrow(RangeError);
    expect(() => jobIdOf('pub', '', 1)).toThrow(RangeError);
    expect(() => jobIdOf('pub', 'a b')).toThrow(RangeError);
    expect(() => stripeJobId('evt:1')).toThrow(RangeError);
  });
});
