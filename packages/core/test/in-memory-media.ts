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
  MediaLimits,
  MediaRendition,
  MediaScope,
  MediaStore,
  MediaUnitOfWork,
  PostMedia,
  PresignedUpload,
  RenderJob,
  RenderOptions,
  StoragePort,
  StoredObject,
  VariantRef,
} from '../src';
import { ImageRejectedError } from '../src';
import { fixedClock, ScopeViolation, sequentialIds } from './in-memory-content';

// In-memory adapters for the media use cases: a unit of work that hides other workspaces and
// rolls back on errors, an object store, a recording job queue and a scriptable image processor.

interface State {
  assets: Map<string, MediaAsset>;
  renditions: Map<string, MediaRendition>;
  /** Further variants using an asset, by asset id, on top of postMedia. */
  usage: Map<string, number>;
  postMedia: Map<string, PostMedia>;
  variants: Map<string, VariantRef & { workspaceId: string }>;
  audit: AuditEntry[];
}

const renditionId = (assetId: string, profile: string, cropHash: string): string =>
  `${assetId}/${profile}/${cropHash}`;

export class InMemoryMedia implements MediaUnitOfWork {
  state: State = {
    assets: new Map(),
    renditions: new Map(),
    usage: new Map(),
    postMedia: new Map(),
    variants: new Map(),
    audit: [],
  };
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
        lockStorage: (organizationId) => {
          if (organizationId !== scope.organizationId) {
            throw new ScopeViolation(`organization ${organizationId} is outside the scope`);
          }
          this.locks += 1;
          return Promise.resolve();
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
          const uses = [...this.state.postMedia.values()].filter((use) => use.assetId === assetId).length;
          return Promise.resolve(uses + (this.state.usage.get(assetId) ?? 0));
        },
      },
      postMedia: {
        find: (workspaceId, postMediaId) => {
          assertScope(workspaceId);
          const use = this.state.postMedia.get(postMediaId);
          return Promise.resolve(use?.workspaceId === workspaceId ? use : null);
        },
        ofVariant: (workspaceId, variantId) => {
          assertScope(workspaceId);
          return Promise.resolve(
            [...this.state.postMedia.values()]
              .filter((use) => use.workspaceId === workspaceId && use.variantId === variantId)
              .sort((a, b) => a.position - b.position),
          );
        },
        replace: (workspaceId, variantId, items) => {
          assertScope(workspaceId);
          for (const [id, use] of this.state.postMedia) {
            if (use.variantId === variantId) {
              this.state.postMedia.delete(id);
            }
          }
          for (const item of items) {
            assertScope(item.workspaceId);
            this.state.postMedia.set(item.id, item);
          }
          return Promise.resolve();
        },
      },
      variants: {
        find: (workspaceId, variantId) => {
          assertScope(workspaceId);
          const variant = this.state.variants.get(variantId);
          return Promise.resolve(
            variant?.workspaceId === workspaceId
              ? {
                  id: variant.id,
                  platform: variant.platform,
                  status: variant.status,
                  version: variant.version,
                }
              : null,
          );
        },
        touch: (workspaceId, variantId, version) => {
          assertScope(workspaceId);
          const variant = this.state.variants.get(variantId);
          if (variant?.workspaceId !== workspaceId || variant.version !== version) {
            return Promise.resolve(false);
          }
          this.state.variants.set(variantId, { ...variant, version: version + 1 });
          return Promise.resolve(true);
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
  /** The uploads signed so far, with the type and length a real storage would insist on. */
  readonly signed: { key: string; contentType: string; contentLength: number }[] = [];

  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedUpload> {
    this.signed.push({ key, contentType: options.contentType, contentLength: options.contentLength });
    return Promise.resolve({
      url: `https://storage.test/${key}?expires=${String(options.expiresInSeconds)}`,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
    });
  }

  /** What a browser upload would store; unlike a real storage it takes any length. */
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
  readonly renders: RenderJob[] = [];
  readonly drops: { job: MediaJob; delaySeconds: number }[] = [];

  process(job: MediaJob): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }

  render(job: RenderJob): Promise<void> {
    this.renders.push(job);
    return Promise.resolve();
  }

  dropUpload(job: MediaJob, delaySeconds: number): Promise<void> {
    this.drops.push({ job, delaySeconds });
    return Promise.resolve();
  }
}

/** An image processor whose answers the test sets; encodings scale the image into the box. */
export class FakeProcessor implements ImageProcessor {
  info: ImageInfo = { format: 'jpeg', width: 4000, height: 3000, frames: 1 };
  /** Thrown by inspect, for example an ImageRejectedError. */
  failure: Error | null = null;
  readonly encodings: EncodeOptions[] = [];
  readonly renders: RenderOptions[] = [];
  /** The bytes a rendition gets, by its options; small by default. */
  renditionBytes: (options: RenderOptions) => number = () => 1000;

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

  render(_bytes: Uint8Array, options: RenderOptions): Promise<EncodedImage> {
    this.renders.push(options);
    const bars = options.extend ?? { top: 0, right: 0, bottom: 0, left: 0 };
    return Promise.resolve({
      bytes: new Uint8Array(this.renditionBytes(options)),
      mimeType: `image/${options.format}`,
      width: options.resize.width + bars.left + bars.right,
      height: options.resize.height + bars.top + bars.bottom,
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

/** The storage of the plan, over the assets of every workspace the in-memory store holds. */
export const memoryMediaLimits = (unitOfWork: InMemoryMedia, storageBytes: number): MediaLimits => ({
  storageBytes: () => Promise.resolve(storageBytes),
  storageUsed: () =>
    Promise.resolve(
      [...unitOfWork.state.assets.values()]
        .filter((asset) => asset.deletedAt === null && asset.status !== 'REJECTED')
        .reduce((sum, asset) => sum + (asset.sizeBytes ?? asset.declaredSize), 0),
    ),
});

export function createMediaTestbed(storageBytes = 100 * 1024 * 1024): MediaTestbed {
  const unitOfWork = new InMemoryMedia();
  return {
    unitOfWork,
    storage: new MemoryStorage(),
    jobs: new RecordingJobs(),
    processor: new FakeProcessor(),
    limits: memoryMediaLimits(unitOfWork, storageBytes),
    clock: fixedClock(),
    ids: sequentialIds('asset'),
  };
}

/** The first bytes of a JPEG, enough for the magic byte check. */
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 60 }, () => 0)]);
