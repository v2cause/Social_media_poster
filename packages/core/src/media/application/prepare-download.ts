import type { ContentActor } from '../../content/domain/types';
import { READ_URL_SECONDS } from '../domain/rules';
import { RenderRendition } from './render-rendition';
import type { MediaDependencies } from './dependencies';

// A download of an image as JPEG (ADR 0048), for posting by hand: the user saves the file and
// uploads it on the platform. The original is never delivered, since it may carry EXIF and GPS
// data; the download is the rendition "x_image", oriented, in sRGB, without metadata and with up
// to 4096 px on its longest side. Made once per asset and kept, like every rendition.

export interface PrepareMediaDownloadInput {
  actor: ContentActor;
  assetId: string;
}

export interface MediaDownload {
  url: string;
  fileName: string;
  expiresAt: Date;
}

/** The name the browser saves the file under: the name in the library, ending in .jpg. */
export function downloadFileName(fileName: string): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return `${base.length > 0 ? base : 'image'}.jpg`;
}

export class PrepareMediaDownload {
  private readonly render: RenderRendition;

  constructor(
    private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'processor' | 'clock' | 'ids'>,
  ) {
    this.render = new RenderRendition(deps);
  }

  async execute(input: PrepareMediaDownloadInput): Promise<MediaDownload> {
    const { actor } = input;
    const rendition = await this.render.execute({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      assetId: input.assetId,
      profile: 'x_image',
      crop: null,
      letterbox: false,
    });
    const asset = await this.deps.unitOfWork.run(
      { userId: actor.userId, organizationId: actor.organizationId, workspaceId: actor.workspaceId },
      (store) => store.assets.find(actor.workspaceId, input.assetId),
    );
    const fileName = downloadFileName(asset?.fileName ?? 'image');
    const url = await this.deps.storage.signedGetUrl(rendition.storageKey, {
      expiresInSeconds: READ_URL_SECONDS,
      downloadName: fileName,
    });
    return { url, fileName, expiresAt: new Date(this.deps.clock.now().getTime() + READ_URL_SECONDS * 1000) };
  }
}
