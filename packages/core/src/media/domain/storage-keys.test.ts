import { describe, expect, it } from 'vitest';

import { assetPrefix, originalKey, renditionKey, uploadKey } from './storage-keys';

const ws = '01a144a9-a274-7767-993c-73a19b361453';
const asset = '01a144a9-a277-7273-a2fa-9fd56a6d87a7';

describe('storage keys', () => {
  it('put every object of an asset under the workspace and the asset', () => {
    expect(originalKey(ws, asset)).toBe(`ws/${ws}/assets/${asset}/original`);
    expect(renditionKey(ws, asset, { profile: 'instagram_feed', cropHash: 'full', extension: 'jpg' })).toBe(
      `ws/${ws}/assets/${asset}/renditions/instagram_feed-full.jpg`,
    );
    expect(uploadKey(ws, asset)).toBe(`ws/${ws}/assets/${asset}/upload`);
    expect(originalKey(ws, asset).startsWith(assetPrefix(ws, asset))).toBe(true);
    expect(uploadKey(ws, asset).startsWith(assetPrefix(ws, asset))).toBe(true);
  });
});
