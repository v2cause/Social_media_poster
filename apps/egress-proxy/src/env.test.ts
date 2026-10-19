import { X_WEB_HOSTS } from '@smp/x-browser';
import { describe, expect, it } from 'vitest';

import { egressHostsOf, loadEgressProxyEnv } from './env';

describe('loadEgressProxyEnv', () => {
  it('listens on 3128 and knows only the hosts of X without further origins', () => {
    const env = loadEgressProxyEnv({});

    expect(env).toMatchObject({ EGRESS_PORT: 3128, EGRESS_POLICY: 'x-browser', XB_EGRESS_HOSTS: [] });
    expect(egressHostsOf(env, X_WEB_HOSTS)).toEqual([...X_WEB_HOSTS]);
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

  it('lets API and worker out to exactly the hosts of EGRESS_HOSTS, none of X (guide step 8.9)', () => {
    const env = loadEgressProxyEnv({
      EGRESS_POLICY: 'hosts',
      EGRESS_HOSTS: 'api.stripe.com,api.anthropic.com,smtp.example.com:587',
    });

    expect(egressHostsOf(env, X_WEB_HOSTS)).toEqual([
      'api.stripe.com',
      'api.anthropic.com',
      'smtp.example.com:587',
    ]);
    expect(egressHostsOf(loadEgressProxyEnv({ EGRESS_POLICY: 'hosts' }), X_WEB_HOSTS)).toEqual([]);
  });

  it('refuses a list that does not belong to the policy', () => {
    expect(() => loadEgressProxyEnv({ EGRESS_HOSTS: 'api.stripe.com' })).toThrow(
      /EGRESS_HOSTS: does not apply/,
    );
    expect(() => loadEgressProxyEnv({ EGRESS_POLICY: 'hosts', XB_EGRESS_HOSTS: 'http://s3:8333' })).toThrow(
      /XB_EGRESS_HOSTS: does not apply/,
    );
    expect(() => loadEgressProxyEnv({ EGRESS_POLICY: 'open' })).toThrow(/EGRESS_POLICY/);
  });
});
