// The type of an image from its first bytes (guide step 3.3: the type the browser announces is
// never trusted). Only the formats the pipeline knows; anything else is null.

export type SniffedImageType =
  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'image/avif';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => Array.from(new TextEncoder().encode(text));

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return 'image/webp';
  }
  // ISO base media files: a box of type "ftyp" at offset 4, then the major brand.
  if (startsWith(bytes, ascii('ftyp'), 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (HEIF_BRANDS.has(brand)) {
      return 'image/heic';
    }
    if (AVIF_BRANDS.has(brand)) {
      return 'image/avif';
    }
  }
  return null;
}
