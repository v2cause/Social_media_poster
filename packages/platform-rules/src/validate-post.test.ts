import { describe, expect, it } from 'vitest';

import { validatePost, type MediaItem } from '.';

const jpeg = (width: number, height: number): MediaItem => ({
  kind: 'image',
  mimeType: 'image/jpeg',
  width,
  height,
});

describe('validatePost', () => {
  it('accepts a post within all limits', () => {
    expect(validatePost({ platform: 'LINKEDIN', text: 'Hallo LinkedIn', hashtags: ['ki'] })).toEqual([]);
    expect(validatePost({ platform: 'INSTAGRAM', text: 'Caption', media: [jpeg(1080, 1350)] })).toEqual([]);
  });

  it('counts the hashtags into the text length', () => {
    // 272 characters, a blank line (2) and "#launch" (7) make 281.
    const text = 'a'.repeat(272);
    expect(validatePost({ platform: 'X', text })).toEqual([]);
    expect(validatePost({ platform: 'X', text, hashtags: ['launch'] })).toEqual([
      { code: 'TEXT_TOO_LONG', limit: 280, actual: 281 },
    ]);
  });

  it('limits Instagram to 30 hashtags and 20 mentions', () => {
    const tags = Array.from({ length: 30 }, (_, index) => `tag${String(index)}`);
    const ok = { platform: 'INSTAGRAM' as const, text: 'Bild', media: [jpeg(1080, 1080)] };
    expect(validatePost({ ...ok, hashtags: tags })).toEqual([]);
    expect(validatePost({ ...ok, text: 'Bild #extra', hashtags: tags })).toEqual([
      { code: 'TOO_MANY_HASHTAGS', limit: 30, actual: 31 },
    ]);
    const mentions = Array.from({ length: 21 }, (_, index) => `@user${String(index)}`).join(' ');
    expect(validatePost({ ...ok, text: mentions })).toEqual([
      { code: 'TOO_MANY_MENTIONS', limit: 20, actual: 21 },
    ]);
  });

  it('requires media on Instagram and checks the aspect ratio between 4:5 and 1.91:1', () => {
    expect(validatePost({ platform: 'INSTAGRAM', text: 'Ohne Bild' })).toEqual([{ code: 'MEDIA_REQUIRED' }]);
    expect(validatePost({ platform: 'INSTAGRAM', text: 'x', media: [jpeg(1080, 566)] })).toEqual([]);
    expect(
      validatePost({ platform: 'INSTAGRAM', text: 'x', media: [jpeg(1080, 1360), jpeg(1080, 560)] }),
    ).toEqual([
      { code: 'ASPECT_RATIO_OUT_OF_RANGE', mediaIndex: 0 },
      { code: 'ASPECT_RATIO_OUT_OF_RANGE', mediaIndex: 1 },
    ]);
  });

  it('allows up to 10 carousel items on Instagram, also images and videos mixed', () => {
    const video: MediaItem = { kind: 'video', mimeType: 'video/mp4' };
    const ten = [...Array.from({ length: 9 }, () => jpeg(1080, 1080)), video];
    expect(validatePost({ platform: 'INSTAGRAM', text: 'x', media: ten })).toEqual([]);
    expect(validatePost({ platform: 'INSTAGRAM', text: 'x', media: [...ten, jpeg(1080, 1080)] })).toEqual([
      { code: 'TOO_MANY_MEDIA', limit: 10, actual: 11 },
    ]);
  });

  it('allows four images, one GIF or one video on X, never mixed', () => {
    const png: MediaItem = { kind: 'image', mimeType: 'image/png' };
    expect(validatePost({ platform: 'X', text: 'x', media: [png, png, png, png] })).toEqual([]);
    expect(validatePost({ platform: 'X', text: 'x', media: [png, png, png, png, png] })).toEqual([
      { code: 'TOO_MANY_MEDIA', limit: 4, actual: 5 },
    ]);
    expect(
      validatePost({ platform: 'X', text: 'x', media: [png, { kind: 'video', mimeType: 'video/mp4' }] }),
    ).toEqual([{ code: 'MIXED_MEDIA_NOT_SUPPORTED' }]);
    expect(
      validatePost({ platform: 'X', text: 'x', media: [{ kind: 'gif', mimeType: 'image/gif' }] }),
    ).toEqual([]);
  });

  it('rejects media types the platform does not publish', () => {
    expect(
      validatePost({ platform: 'X', text: 'x', media: [{ kind: 'video', mimeType: 'video/quicktime' }] }),
    ).toEqual([{ code: 'UNSUPPORTED_MEDIA_TYPE', mediaIndex: 0 }]);
    expect(
      validatePost({ platform: 'INSTAGRAM', text: 'x', media: [{ kind: 'image', mimeType: 'image/png' }] }),
    ).toEqual([{ code: 'UNSUPPORTED_MEDIA_TYPE', mediaIndex: 0 }]);
    expect(
      validatePost({ platform: 'LINKEDIN', text: 'x', media: [{ kind: 'gif', mimeType: 'image/gif' }] }),
    ).toEqual([{ code: 'UNSUPPORTED_MEDIA_TYPE', mediaIndex: 0 }]);
  });

  it('allows a first comment where the platform supports it', () => {
    expect(validatePost({ platform: 'LINKEDIN', text: 'x', firstComment: 'Link im Kommentar' })).toEqual([]);
    expect(validatePost({ platform: 'X', text: 'x', firstComment: 'Antwort' })).toEqual([
      { code: 'FIRST_COMMENT_NOT_SUPPORTED' },
    ]);
    expect(validatePost({ platform: 'X', text: 'x', firstComment: '  ' })).toEqual([]);
  });
});
