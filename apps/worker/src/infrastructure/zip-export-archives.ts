import { Readable } from 'node:stream';

import type { ExportArchive, ExportArchives } from '@smp/core';
import archiver from 'archiver';

// The archive of an export as ZIP (guide step 8.1, ADR 0036), written straight into the object
// storage while it grows: archiver packs the entries one after another, and a multipart upload
// takes the bytes. Nothing of the archive lies on the disk of the worker. JSON is deflated,
// images are stored as they are. An entry that fails, or an upload that fails, stops the archive.

/** Deflate level 6: the default of zlib, a good trade of size and time for JSON. */
const JSON_LEVEL = 6;

export interface ArchiveUploads {
  putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    options: { contentType: string },
  ): Promise<{ bytes: number }>;
}

class ZipExportArchive implements ExportArchive {
  private readonly zip = archiver('zip', { zlib: { level: JSON_LEVEL } });
  private readonly upload: Promise<{ bytes: number }>;
  /** Rejects with the first failure of the archive or of the upload. */
  private readonly broken: Promise<never>;

  constructor(
    uploads: ArchiveUploads,
    key: string,
    /** The time of every entry, so that the archive does not depend on how long it took. */
    private readonly date: Date,
  ) {
    this.upload = uploads.putStream(key, this.zip, { contentType: 'application/zip' });
    this.broken = new Promise<never>((_resolve, reject) => {
      this.zip.once('error', reject);
      this.upload.catch(reject);
    });
    // Awaited by every step; this keeps a failure between two steps from being unhandled.
    this.broken.catch(() => undefined);
  }

  async addJsonArray(name: string, items: AsyncIterable<string>): Promise<number> {
    let count = 0;
    async function* array(): AsyncGenerator<Buffer> {
      yield Buffer.from('[');
      for await (const item of items) {
        yield Buffer.from(`${count === 0 ? '\n' : ',\n'}${item}`);
        count += 1;
      }
      yield Buffer.from(count === 0 ? ']\n' : '\n]\n');
    }
    await this.append(Readable.from(array(), { objectMode: false }), name, true);
    return count;
  }

  async addFile(name: string, body: Uint8Array, options?: { compress?: boolean }): Promise<void> {
    await this.append(
      Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      name,
      options?.compress ?? true,
    );
  }

  async finish(): Promise<{ bytes: number }> {
    await Promise.race([this.zip.finalize(), this.broken]);
    return this.upload;
  }

  async abort(): Promise<void> {
    // destroy, not abort: archiver's abort ends the stream, and the upload would keep a half archive.
    this.zip.destroy(new Error('The export was aborted.'));
    await this.upload.catch(() => undefined);
  }

  /** Adds one entry and waits until archiver has written all of it. */
  private async append(source: Readable | Buffer, name: string, compress: boolean): Promise<void> {
    const written = new Promise<void>((resolve) => {
      const onEntry = (entry: archiver.EntryData): void => {
        if (entry.name === name) {
          this.zip.off('entry', onEntry);
          resolve();
        }
      };
      this.zip.on('entry', onEntry);
    });
    this.zip.append(source, { name, date: this.date, store: !compress });
    await Promise.race([written, this.broken]);
  }
}

export class ZipExportArchives implements ExportArchives {
  constructor(
    private readonly uploads: ArchiveUploads,
    private readonly now: () => Date,
  ) {}

  create(key: string): ExportArchive {
    return new ZipExportArchive(this.uploads, key, this.now());
  }
}
