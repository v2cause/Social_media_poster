import { crc32, inflateRawSync } from 'node:zlib';

// A small reader of ZIP archives for the tests, independent of the library that writes them: it
// follows the central directory, inflates every entry and checks its size and CRC-32. Archives
// beyond 4 GiB (ZIP64) are not needed here.

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  data: Buffer;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** General purpose bit 11: the name is UTF-8. */
const UTF8_NAMES = 0x800;

export function readZip(archive: Buffer): ZipEntry[] {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) {
    end -= 1;
  }
  if (end < 0) {
    throw new Error('Not a ZIP archive: no end of the central directory.');
  }
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`Entry ${String(index)} of the central directory is broken.`);
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString((flags & UTF8_NAMES) === UTF8_NAMES ? 'utf8' : 'latin1');
    if (archive.readUInt32LE(local) !== LOCAL_FILE_HEADER) {
      throw new Error(`The local header of ${name} is missing.`);
    }
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`${name} uses the unknown method ${String(method)}.`);
    }
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size || crc32(data) !== checksum) {
      throw new Error(`${name} does not match its size or CRC-32.`);
    }
    entries.push({ name, method, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
