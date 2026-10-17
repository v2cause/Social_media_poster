import { describe, expect, it } from 'vitest';

import { loadEgressProxyEnv } from './env';

describe('loadEgressProxyEnv', () => {
  it('listens on 3128 and knows only the hosts of X without further origins', () => {
    expect(loadEgressProxyEnv({})).toMatchObject({ EGRESS_PORT: 3128, XB_EGRESS_HOSTS: [] });
  });

  it('reads the port and the origins of the media storage', () => {
    expect(loadEgressProxyEnv({ EGRESS_PORT: '8888', XB_EGRESS_HOSTS: 'http://s3:8333' })).toMatchObject({
      EGRESS_PORT: 8888,
      XB_EGRESS_HOSTS: ['http://s3:8333'],
    });
  });

  it('refuses an entry the policy cannot read', () => {
    expect(() => loadEgressProxyEnv({ XB_EGRESS_HOSTS: 'http://s3:8333/bucket' })).toThrow(/XB_EGRESS_HOSTS/);
  });
});
