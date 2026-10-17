import { describe, expect, it } from 'vitest';

import { egressEntriesOf, egressPolicy, X_WEB_HOSTS } from './egress';

// Guide step 6.2: the browser reaches the web app of X and the storage of the media, nothing
// else, and the proxy of the network applies the same list.

describe('egress policy', () => {
  const policy = egressPolicy([...X_WEB_HOSTS, 'http://s3:8333', 'https://media.example.com']);

  it('lets the pages load the web app of X over TLS', () => {
    for (const url of [
      'https://x.com/home',
      'https://api.x.com/graphql/abc/CreateTweet',
      'https://abs.twimg.com/responsive-web/client-web/main.js',
      'https://pbs.twimg.com/media/abc.jpg',
      'wss://stream.x.com/',
      'https://x.com:443/i/flow/login',
    ]) {
      expect(policy.allowsUrl(url), url).toBe(true);
    }
  });

  it('refuses every other host, port and scheme', () => {
    for (const url of [
      'http://x.com/home',
      'https://x.com:8443/',
      'https://evil.example/',
      'https://x.com.evil.example/',
      'https://evilx.com/',
      'https://x.com@evil.example/',
      'https://xtwimg.com/',
      'file:///etc/passwd',
      'ftp://x.com/',
      'chrome://settings',
      'https://[::1]/',
      'not a url',
    ]) {
      expect(policy.allowsUrl(url), url).toBe(false);
    }
  });

  it('keeps data, blob and the empty page inside the browser', () => {
    expect(policy.allowsUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(policy.allowsUrl('blob:https://x.com/0b6c1d6e-6e5c-4a54-8f0b-4b8d9b1f8f6e')).toBe(true);
    expect(policy.allowsUrl('about:blank')).toBe(true);
  });

  it('allows plain http only for an origin that names it, on its port', () => {
    expect(policy.allowsUrl('http://s3:8333/smp-media/a.jpg?X-Amz-Signature=abc')).toBe(true);
    expect(policy.allowsUrl('https://s3:8333/smp-media/a.jpg')).toBe(false);
    expect(policy.allowsUrl('http://s3/smp-media/a.jpg')).toBe(false);
    expect(policy.allowsUrl('https://media.example.com/a.jpg')).toBe(true);
    expect(policy.allowsUrl('https://cdn.media.example.com/a.jpg')).toBe(false);
  });

  it('answers the proxy for tunnels and plain requests', () => {
    expect(policy.allowsTunnel('x.com', 443)).toBe(true);
    expect(policy.allowsTunnel('ABS.TWIMG.COM', 443)).toBe(true);
    expect(policy.allowsTunnel('x.com', 80)).toBe(false);
    expect(policy.allowsTunnel('s3', 8333)).toBe(true);
    expect(policy.allowsTunnel('s3', 443)).toBe(false);
    expect(policy.allowsPlain('s3', 8333)).toBe(true);
    expect(policy.allowsPlain('x.com', 80)).toBe(false);
    expect(policy.allowsTunnel('localhost', 443)).toBe(false);
  });

  it('fails on an entry it cannot read instead of widening the list', () => {
    for (const entry of [
      '',
      '*.',
      'x.com:8443',
      'https://x.com/path',
      'https://user@x.com',
      'ftp://x.com',
      'https://x.com?a=1',
      'exa mple.com',
    ]) {
      expect(() => egressPolicy([entry]), entry).toThrow(/Invalid egress entry/);
    }
    expect(egressPolicy([]).allowsUrl('https://x.com/')).toBe(false);
  });

  it('reads a comma-separated list from the environment', () => {
    expect(egressEntriesOf(' http://s3:8333, ,https://media.example.com ,')).toEqual([
      'http://s3:8333',
      'https://media.example.com',
    ]);
    expect(egressEntriesOf(undefined)).toEqual([]);
  });
});
