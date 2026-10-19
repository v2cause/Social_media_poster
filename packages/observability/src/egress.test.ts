import { describe, expect, it } from 'vitest';

import { checkEgressEnv, egressEnvSchema, proxyEnvOf } from './egress';

const schema = egressEnvSchema.superRefine(checkEgressEnv);

describe('proxyEnvOf', () => {
  it('hands the proxy to the agents only when Node sends fetch through it as well', () => {
    const env = schema.parse({
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://egress:3128',
      NO_PROXY: 'postgres,redis,s3',
    });

    expect(proxyEnvOf(env)).toEqual({
      HTTPS_PROXY: 'http://egress:3128',
      HTTP_PROXY: undefined,
      NO_PROXY: 'postgres,redis,s3',
    });
    expect(proxyEnvOf(schema.parse({ HTTPS_PROXY: 'http://egress:3128' }))).toBeUndefined();
    expect(
      proxyEnvOf(schema.parse({ NODE_USE_ENV_PROXY: '0', HTTPS_PROXY: 'http://egress:3128' })),
    ).toBeUndefined();
    expect(proxyEnvOf(schema.parse({ NODE_USE_ENV_PROXY: '', HTTPS_PROXY: '' }))).toBeUndefined();
  });
});

describe('checkEgressEnv', () => {
  const issues = (env: Record<string, string>): string[] =>
    (schema.safeParse(env).error?.issues ?? []).map((issue) => issue.path.join('.'));

  it('needs an HTTPS_PROXY of http or https once Node uses the proxy', () => {
    expect(issues({ NODE_USE_ENV_PROXY: '1' })).toEqual(['HTTPS_PROXY']);
    expect(issues({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'egress:3128' })).toEqual(['HTTPS_PROXY']);
    expect(
      issues({
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: 'http://egress:3128',
        HTTP_PROXY: 'socks5://egress:1080',
      }),
    ).toEqual(['HTTP_PROXY']);
    expect(issues({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'https://egress:3129' })).toEqual([]);
  });

  it('refuses values Node would ignore, and leaves the proxy of a developer machine alone', () => {
    expect(issues({ NODE_USE_ENV_PROXY: 'true', HTTPS_PROXY: 'http://egress:3128' })).toEqual([
      'NODE_USE_ENV_PROXY',
    ]);
    expect(issues({ HTTPS_PROXY: 'proxy.corp.example:8080' })).toEqual([]);
  });
});
