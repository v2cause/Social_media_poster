import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignedUpload, StoragePort, StoredObject } from '@smp/core';

// The StoragePort on the S3 API (guide step 3.2, ADR 0008), locally against SeaweedFS.

export interface S3StorageConfig {
  endpoint: string;
  /** The address the browser reaches, when it differs from the endpoint of the services. */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** An object is larger than the caller allowed to read into memory. */
export class StorageObjectTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`The object has ${String(size)} bytes, more than the allowed ${String(maxBytes)}.`);
    this.name = 'StorageObjectTooLargeError';
  }
}

// Only prefixes of one workspace, or of the exports of one organization, may be deleted at once, so
// a bug can never empty the bucket. The erasure of an organization removes both (guide step 8.2).
const DELETABLE_PREFIX = /^(ws|exports)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//;
/**
 * The parts of a streamed upload. S3 takes at most 10,000 parts, so one stream holds up to about
 * 156 GiB; every part but the last must have at least 5 MiB.
 */
const PART_BYTES = 16 * 1024 * 1024;

const clientFor = (config: S3StorageConfig, endpoint: string): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    // Newer SDKs add a CRC32 checksum to presigned requests, computed for an empty body, and the
    // browser upload then fails the signature (ADR 0008). Checksums only where S3 requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

/** A file name for Content-Disposition: printable ASCII without quotes and backslashes. */
const asciiFileName = (name: string): string => name.replace(/[^\x20-\x7e]|["\\]/g, '_');

const isNotFound = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404);

export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  /** Signs URLs for the browser; the same client when there is no separate public endpoint. */
  private readonly signer: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = clientFor(config, config.endpoint);
    this.signer =
      config.publicEndpoint === undefined || config.publicEndpoint === config.endpoint
        ? this.client
        : clientFor(config, config.publicEndpoint);
  }

  async presignPut(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: options.contentType }),
      // The upload must send exactly this content type; another one fails the signature.
      { expiresIn: options.expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
    return { url, method: 'PUT', headers: { 'Content-Type': options.contentType } };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  signedGetUrl(key: string, options: { expiresInSeconds: number; downloadName?: string }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ...(options.downloadName
        ? { ResponseContentDisposition: `attachment; filename="${asciiFileName(options.downloadName)}"` }
        : {}),
    });
    return getSignedUrl(this.signer, command, { expiresIn: options.expiresInSeconds });
  }

  async get(key: string, options: { maxBytes: number }): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const announced = result.ContentLength ?? 0;
    if (announced > options.maxBytes) {
      result.Body?.transformToWebStream()
        .cancel()
        .catch(() => undefined);
      throw new StorageObjectTooLargeError(announced, options.maxBytes);
    }
    if (!result.Body) {
      return new Uint8Array();
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > options.maxBytes) {
      throw new StorageObjectTooLargeError(bytes.byteLength, options.maxBytes);
    }
    return bytes;
  }

  async put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  /**
   * Stores a stream of unknown length, such as an archive while it is written, through a
   * multipart upload with one part in memory at a time. A failure aborts the upload, so no part
   * is left behind; the object appears only when the stream ended.
   */
  async putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    options: { contentType: string; partBytes?: number },
  ): Promise<{ bytes: number }> {
    const partBytes = Math.max(options.partBytes ?? PART_BYTES, 5 * 1024 * 1024);
    const target = { Bucket: this.config.bucket, Key: key };
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ ...target, ContentType: options.contentType }),
    );
    if (!UploadId) {
      throw new Error('The storage started a multipart upload without an id.');
    }
    const parts: { ETag: string; PartNumber: number }[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let bytes = 0;
    const uploadPart = async (): Promise<void> => {
      const part = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const PartNumber = parts.length + 1;
      const { ETag } = await this.client.send(
        new UploadPartCommand({
          ...target,
          UploadId,
          PartNumber,
          Body: part,
          ContentLength: part.byteLength,
        }),
      );
      if (!ETag) {
        throw new Error(`The storage took part ${String(PartNumber)} without an ETag.`);
      }
      parts.push({ ETag, PartNumber });
    };
    try {
      for await (const chunk of body) {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        bytes += chunk.byteLength;
        if (pendingBytes >= partBytes) {
          await uploadPart();
        }
      }
      // The last part may be small; an empty stream still needs one part.
      if (pendingBytes > 0 || parts.length === 0) {
        await uploadPart();
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({ ...target, UploadId, MultipartUpload: { Parts: parts } }),
      );
      return { bytes };
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ ...target, UploadId })).catch(() => undefined);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  /** How many objects lie under the prefix of one workspace or of the exports of one organization. */
  async countPrefix(prefix: string): Promise<number> {
    if (!DELETABLE_PREFIX.test(prefix)) {
      throw new RangeError(
        'Only the prefix of one workspace or of the exports of one organization can be counted.',
      );
    }
    let count = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      count += page.KeyCount ?? (page.Contents ?? []).length;
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return count;
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!DELETABLE_PREFIX.test(prefix)) {
      throw new RangeError(
        'Only the prefix of one workspace or of the exports of one organization can be deleted.',
      );
    }
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += keys.length;
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return deleted;
  }

  /** Closes the connections. */
  destroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) {
      this.signer.destroy();
    }
  }
}
