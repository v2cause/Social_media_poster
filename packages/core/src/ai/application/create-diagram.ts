import { assertCanWrite, scopeOf } from '../../content/application/dependencies';
import type { ContentActor } from '../../content/domain/types';
import {
  assertCanWriteMedia,
  mediaScopeOf,
  type MediaDependencies,
} from '../../media/application/dependencies';
import { DiagramRejectedError, StorageQuotaExceededError } from '../../media/domain/errors';
import { displayFileName } from '../../media/domain/rules';
import { originalKey, uploadKey } from '../../media/domain/storage-keys';
import type { MediaAsset } from '../../media/domain/types';
import type { DiagramRenderer } from '../../media/ports/diagram-renderer';
import { AiCallFailedError } from '../domain/errors';
import {
  DIAGRAM_SIZES,
  type AiCallReport,
  type AiFailure,
  type ContentLanguage,
  type DiagramFormat,
} from '../domain/types';
import type { GeneratedDiagram, GenerateDiagramInput } from '../ports/ai-provider';
import {
  brandOf,
  effortOf,
  outcomeOf,
  startMeteredCall,
  unexpectedFailure,
  type AiDependencies,
} from './ai-dependencies';

// A diagram as an image for a post (ADR 0048). Claude draws it as SVG in the brand context of the
// workspace; the renderer checks the markup against its allowlist and turns it into a JPEG of the
// chosen format. The JPEG enters the media library like an upload: as an asset whose file waits
// in the upload object, which media.process checks and turns into the original with thumbnails.
// The call counts against the AI quota and uses the effort of the route "generate".

/** The longest description of a diagram. */
export const DIAGRAM_DESCRIPTION_MAX = 2000;
/** The longest alt text the asset keeps from the model. */
const ALT_TEXT_MAX = 1000;
const TITLE_MAX = 120;

export interface CreateDiagramCommand {
  actor: ContentActor;
  description: string;
  format: DiagramFormat;
  /** The language of the labels; the content language of the workspace when missing. */
  language?: ContentLanguage;
  /** The brand voice whose tone and colors the diagram follows; none when missing. */
  brandVoiceId?: string | null;
  signal?: AbortSignal;
}

export interface CreatedDiagram {
  asset: MediaAsset;
  title: string;
  altText: string;
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** A file name from the title: letters and digits, words joined by "-". */
export function diagramFileName(title: string): string {
  const base = title
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return displayFileName(`${base.length > 0 ? base : 'diagram'}.jpg`);
}

export class CreateDiagram {
  constructor(
    private readonly deps: AiDependencies,
    private readonly media: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'jobs' | 'limits' | 'ids'>,
    private readonly renderer: DiagramRenderer,
  ) {}

  async execute(command: CreateDiagramCommand): Promise<CreatedDiagram> {
    const { actor } = command;
    assertCanWrite(actor);
    assertCanWriteMedia(actor);
    const scope = scopeOf(actor);

    // A full storage fails before the call, so that it costs nothing.
    const allowed = await this.media.limits.storageBytes(actor.organizationId);
    if ((await this.media.limits.storageUsed(actor.organizationId)) >= allowed) {
      throw new StorageQuotaExceededError();
    }

    const { language, effort, brand } = await this.deps.unitOfWork.run(scope, async (store) => ({
      language: command.language ?? (await store.workspaces.languageOf(actor.workspaceId)),
      effort: await effortOf(store, actor.workspaceId, 'generate', this.deps.efforts),
      brand: await brandOf(store, actor.workspaceId, command.brandVoiceId ?? null),
    }));
    const input: GenerateDiagramInput = {
      brand: brand.context,
      language,
      format: command.format,
      description: command.description.trim().slice(0, DIAGRAM_DESCRIPTION_MAX),
    };
    const call = await startMeteredCall(
      this.deps,
      {
        scope,
        task: 'DIAGRAM',
        postId: null,
        brandVoiceVersionId: brand.brandVoiceVersionId,
        effort,
        // Sizes only: the description stays out of the log.
        input: { format: command.format, language, descriptionLength: input.description.length },
      },
      this.deps.estimator.estimate({ task: 'diagram', input }),
    );

    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let drawn: { diagram: GeneratedDiagram; jpeg: Uint8Array } | null = null;
    try {
      const result = await this.deps.provider
        .generateDiagram(input, { effort, ...(command.signal ? { signal: command.signal } : {}) })
        .catch((error: unknown) => {
          failure = unexpectedFailure(error);
          throw error;
        });
      report = result.report;
      if (!result.ok) {
        failure = result.failure;
        throw new AiCallFailedError(result.failure);
      }
      try {
        const jpeg = await this.renderer.render(result.value.svg, DIAGRAM_SIZES[command.format]);
        drawn = { diagram: result.value, jpeg };
      } catch (error) {
        if (error instanceof DiagramRejectedError) {
          failure = {
            code: 'INVALID_OUTPUT',
            retryable: true,
            detail: `diagram rejected: ${error.reason}`,
            refusalCategory: null,
            status: null,
          };
        }
        throw error;
      }
    } finally {
      await call.finish({
        report,
        outcome: outcomeOf(failure, drawn !== null),
        output:
          drawn === null
            ? null
            : {
                title: drawn.diagram.title,
                altText: drawn.diagram.altText,
                svgLength: drawn.diagram.svg.length,
              },
      });
    }

    const title = oneLine(drawn.diagram.title, TITLE_MAX);
    const altText = oneLine(drawn.diagram.altText, ALT_TEXT_MAX);
    const asset = await this.store(actor, drawn.jpeg, diagramFileName(title), altText);
    return { asset, title, altText };
  }

  /** Stores the JPEG the way a finished upload arrives and hands it to media.process. */
  private async store(
    actor: ContentActor,
    jpeg: Uint8Array,
    fileName: string,
    altText: string,
  ): Promise<MediaAsset> {
    const assetId = this.media.ids.newId();
    const asset: MediaAsset = {
      id: assetId,
      workspaceId: actor.workspaceId,
      status: 'PENDING_UPLOAD',
      fileName,
      declaredMimeType: 'image/jpeg',
      declaredSize: jpeg.byteLength,
      storageKey: originalKey(actor.workspaceId, assetId),
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      sha256: null,
      rejectReason: null,
      altText: altText.length > 0 ? altText : null,
      uploadedById: actor.userId,
      version: 0,
      processedAt: null,
      deletedAt: null,
    };
    const scope = mediaScopeOf(actor);
    const allowed = await this.media.limits.storageBytes(actor.organizationId);
    await this.media.unitOfWork.run(scope, async (store) => {
      await store.assets.lockStorage(actor.organizationId);
      const used = await this.media.limits.storageUsed(actor.organizationId);
      if (used + jpeg.byteLength > allowed) {
        throw new StorageQuotaExceededError();
      }
      await store.assets.insert(asset);
    });
    await this.media.storage.put(uploadKey(actor.workspaceId, assetId), jpeg, { contentType: 'image/jpeg' });
    const started = await this.media.unitOfWork.run(scope, (store) =>
      store.assets.startProcessing(actor.workspaceId, assetId, jpeg.byteLength),
    );
    if (started) {
      await this.media.jobs.process({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        assetId,
      });
    }
    return (
      (await this.media.unitOfWork.run(scope, (store) => store.assets.find(actor.workspaceId, assetId))) ??
      asset
    );
  }
}
