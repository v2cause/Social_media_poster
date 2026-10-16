import type {
  AuditEntry,
  EncodedImage,
  EncodeOptions,
  ImageInfo,
  ImageProcessor,
  MediaAsset,
  MediaDependencies,
  MediaJob,
  MediaJobs,
  MediaRendition,
  MediaScope,
  MediaStore,
  MediaUnitOfWork,
  PresignedUpload,
  StoragePort,
  StoredObject,
} from '../src';
import { ImageRejectedError } from '../src';
import { fixedClock, ScopeViolation, sequentialIds } from './in-memory-content';

// In-memory adapters for the media use cases: a unit of work that hides other workspaces and
// rolls back on errors, an object store, a recording job queue and a scriptable image processor.

interface State {
  assets: Map<string, MediaAsset>;
  renditions: Map<string, MediaRendition>;
  /** Variants using an asset, by asset id. */
  usage: Map<string, number>;
  audit: AuditEntry[];
}

const renditionId = (assetId: string, profile: string, cropHash: string): string =>
  `${assetId}/${profile}/${cropHash}`;

export class InMemoryMedia implements MediaUnitOfWork {
  state: State = { assets: new Map(), renditions: new Map(), usage: new Map(), audit: [] };
  readonly scopes: MediaScope[] = [];
  locks = 0;

  async run<T>(scope: MediaScope, work: (store: MediaStore) => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private storeFor(scope: MediaScope): MediaStore {
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    const own = (workspaceId: string, assetId: string): MediaAsset | null => {
      assertScope(workspaceId);
      const asset = this.state.assets.get(assetId);
      return asset?.workspaceId === workspaceId ? asset : null;
    };
    const transition = (
      workspaceId: string,
      assetId: string,
      from: readonly MediaAsset['status'][],
      patch: Partial<MediaAsset>,
    ): boolean => {
      const asset = own(workspaceId, assetId);
      if (!asset || !from.includes(asset.status)) {
        return false;
      }
      this.state.assets.set(assetId, { ...asset, ...patch, version: asset.version + 1 });
      return true;
    };

    return {
      assets: {
        find: (workspaceId, assetId) => Promise.resolve(own(workspaceId, assetId)),
        insert: (asset) => {
          assertScope(asset.workspaceId);
          this.state.assets.set(asset.id, asset);
          return Promise.resolve();
        },
        lockStorage: (workspaceId) => {
          assertScope(workspaceId);
          this.locks += 1;
          return Promise.resolve();
        },
        storageUsed: (workspaceId) => {
          assertScope(workspaceId);
          const sizes = [...this.state.assets.values()]
            .filter((asset) => asset.workspaceId === workspaceId)
            .filter((asset) => asset.deletedAt === null && asset.status !== 'REJECTED')
            .map((asset) => asset.sizeBytes ?? asset.declaredSize);
          return Promise.resolve(sizes.reduce((sum, size) => sum + size, 0));
        },
        startProcessing: (workspaceId, assetId, sizeBytes) =>
          Promise.resolve(
            transition(workspaceId, assetId, ['PENDING_UPLOAD'], { status: 'PROCESSING', sizeBytes }),
          ),
        finishProcessing: (workspaceId, assetId, result) =>
          Promise.resolve(
            transition(workspaceId, assetId, ['PROCESSING'], {
              status: 'READY',
              mimeType: result.mimeType,
              width: result.width,
              height: result.height,
              sha256: result.sha256,
              processedAt: result.processedAt,
            }),
          ),
        reject: (workspaceId, assetId, reason, sizeBytes) =>
          Promise.resolve(
            transition(workspaceId, assetId, ['PENDING_UPLOAD', 'PROCESSING'], {
              status: 'REJECTED',
              rejectReason: reason,
              sizeBytes,
            }),
          ),
        updateAltText: (workspaceId, assetId, version, altText) => {
          const asset = own(workspaceId, assetId);
          if (asset?.version !== version) {
            return Promise.resolve(false);
          }
          this.state.assets.set(assetId, { ...asset, altText, version: version + 1 });
          return Promise.resolve(true);
        },
        markDeleted: (workspaceId, assetId, deletedAt) => {
          const asset = own(workspaceId, assetId);
          if (asset) {
            this.state.assets.set(assetId, { ...asset, deletedAt, version: asset.version + 1 });
          }
          return Promise.resolve();
        },
        usageCount: (workspaceId, assetId) => {
          assertScope(workspaceId);
          return Promise.resolve(this.state.usage.get(assetId) ?? 0);
        },
      },
      renditions: {
        find: (workspaceId, assetId, profile, cropHash) => {
          assertScope(workspaceId);
          return Promise.resolve(this.state.renditions.get(renditionId(assetId, profile, cropHash)) ?? null);
        },
        upsert: (rendition) => {
          assertScope(rendition.workspaceId);
          this.state.renditions.set(
            renditionId(rendition.assetId, rendition.profile, rendition.cropHash),
            rendition,
          );
          return Promise.resolve();
        },
      },
      audit: {
        record: (entry) => {
          this.state.audit.push(entry);
          return Promise.resolve();
        },
      },
    };
  }
}

export class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly signed: string[] = [];

  presignPut(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    this.signed.push(key);
    return Promise.resolve({
      url: `https://storage.test/${key}?expires=${String(options.expiresInSeconds)}`,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
    });
  }

  /** What a browser upload would store. */
  upload(key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, { bytes, contentType });
  }

  head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { size: object.bytes.byteLength, contentType: object.contentType } : null,
    );
  }

  signedGetUrl(key: string): Promise<string> {
    return Promise.resolve(`https://storage.test/${key}?signed`);
  }

  get(key: string, options: { maxBytes: number }): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) {
      return Promise.reject(new Error(`no object ${key}`));
    }
    if (object.bytes.byteLength > options.maxBytes) {
      return Promise.reject(new Error('too large'));
    }
    return Promise.resolve(object.bytes);
  }

  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void> {
    this.objects.set(key, { bytes: body, contentType: options.contentType });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  deletePrefix(prefix: string): Promise<number> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      this.objects.delete(key);
    }
    return Promise.resolve(keys.length);
  }
}

export class RecordingJobs implements MediaJobs {
  readonly jobs: MediaJob[] = [];

  process(job: MediaJob): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }
}

/** An image processor whose answers the test sets; encodings scale the image into the box. */
export class FakeProcessor implements ImageProcessor {
  info: ImageInfo = { format: 'jpeg', width: 4000, height: 3000, frames: 1 };
  /** Thrown by inspect, for example an ImageRejectedError. */
  failure: Error | null = null;
  readonly encodings: EncodeOptions[] = [];

  inspect(): Promise<ImageInfo> {
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.info);
  }

  encode(_bytes: Uint8Array, options: EncodeOptions): Promise<EncodedImage> {
    this.encodings.push(options);
    const scale = Math.min(1, options.maxWidth / this.info.width, options.maxHeight / this.info.height);
    return Promise.resolve({
      bytes: new Uint8Array(16),
      mimeType: `image/${options.format}`,
      width: Math.round(this.info.width * scale),
      height: Math.round(this.info.height * scale),
    });
  }

  sha256(bytes: Uint8Array): string {
    return `sha256-of-${String(bytes.byteLength)}-bytes`;
  }

  rejectWith(reason: ConstructorParameters<typeof ImageRejectedError>[0]): void {
    this.failure = new ImageRejectedError(reason);
  }
}

export interface MediaTestbed extends MediaDependencies {
  unitOfWork: InMemoryMedia;
  storage: MemoryStorage;
  jobs: RecordingJobs;
  processor: FakeProcessor;
}

export const createMediaTestbed = (storageBytes = 100 * 1024 * 1024): MediaTestbed => ({
  unitOfWork: new InMemoryMedia(),
  storage: new MemoryStorage(),
  jobs: new RecordingJobs(),
  processor: new FakeProcessor(),
  limits: { storageBytes },
  clock: fixedClock(),
  ids: sequentialIds('asset'),
});

/** The first bytes of a JPEG, enough for the magic byte check. */
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 60 }, () => 0)]);
