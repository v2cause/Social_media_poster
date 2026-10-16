import { describe, expect, it } from 'vitest';

import { sniffImageType } from './file-signature';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === 'string' ? Array.from(new TextEncoder().encode(part)) : part)),
  );

describe('sniffImageType', () => {
  it('recognizes the formats the pipeline takes by their first bytes', () => {
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'))).toBe('image/jpeg');
    expect(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(sniffImageType(bytes('GIF89a', [1, 0]))).toBe('image/gif');
    expect(sniffImageType(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
  });

  it('tells HEIC and AVIF apart, which the pipeline refuses with their own reason', () => {
    expect(sniffImageType(bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0]))).toBe('image/heic');
    expect(sniffImageType(bytes([0, 0, 0, 24], 'ftypmif1'))).toBe('image/heic');
    expect(sniffImageType(bytes([0, 0, 0, 24], 'ftypavif'))).toBe('image/avif');
  });

  it('answers null for everything else, whatever the file is called', () => {
    expect(sniffImageType(bytes('<!DOCTYPE html><html>'))).toBeNull();
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffImageType(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(bytes([0xff, 0xd8]))).toBeNull();
  });
});
