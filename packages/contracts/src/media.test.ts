import { describe, expect, it } from 'vitest';

import { ALT_TEXT_MAX_LENGTH, mediaListQuerySchema, requestUploadSchema, updateMediaSchema } from './media';

describe('media requests', () => {
  it('takes what the browser reports and leaves type and size limits to the API', () => {
    expect(
      requestUploadSchema.safeParse({ fileName: 'photo.heic', mimeType: 'image/heic', size: 50_000_000 })
        .success,
    ).toBe(true);
    expect(
      requestUploadSchema.safeParse({ fileName: 'empty.jpg', mimeType: 'image/jpeg', size: 0 }).success,
    ).toBe(false);
    expect(
      requestUploadSchema.safeParse({ fileName: 'a.jpg', mimeType: 'image/jpeg', size: 1.5 }).success,
    ).toBe(false);
  });

  it('reads the filters of the library from the query string', () => {
    expect(mediaListQuerySchema.parse({ limit: '10', usage: 'unused' })).toEqual({
      limit: 10,
      usage: 'unused',
    });
    expect(mediaListQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(mediaListQuerySchema.safeParse({ usage: 'sometimes' }).success).toBe(false);
  });

  it('removes the alt text with null and limits its length', () => {
    expect(updateMediaSchema.parse({ version: 2, altText: null })).toEqual({ version: 2, altText: null });
    expect(
      updateMediaSchema.safeParse({ version: 2, altText: 'x'.repeat(ALT_TEXT_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(updateMediaSchema.safeParse({ altText: 'no version' }).success).toBe(false);
  });
});
