import { RENDITION_PROFILES } from '@smp/platform-rules';

import { assertCanWrite, scopeOf } from '../../content/application/dependencies';
import type { ContentActor } from '../../content/domain/types';
import type { MediaDependencies } from '../../media/application/dependencies';
import { RenderRendition } from '../../media/application/render-rendition';
import { AiCallFailedError } from '../domain/errors';
import type { AiCallReport, AiFailure, ContentLanguage } from '../domain/types';
import type { SuggestAltTextInput } from '../ports/ai-provider';
import {
  effortOf,
  outcomeOf,
  startMeteredCall,
  unexpectedFailure,
  type AiDependencies,
} from './ai-dependencies';

// A suggested alt text for an image (guide step 3.5). Claude gets the image with its longest side
// at 1568 px and writes one or two factual sentences in the language of the content. The call
// counts against the AI quota. The suggestion is only returned: the user confirms or edits it,
// nothing is saved here.

/** The longest suggestion the prompt asks for. */
export const ALT_TEXT_SUGGESTION_MAX = 250;

export interface SuggestAltTextCommand {
  actor: ContentActor;
  assetId: string;
  /** The language of the post; the content language of the workspace when missing. */
  language?: ContentLanguage;
  /** What the post is about, to focus the description. */
  context?: string;
  signal?: AbortSignal;
}

const CHUNK = 0x8000;

/** Base64 without Node APIs, in chunks so that large images do not overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** One line of at most 250 characters, cut at a word where the model wrote more. */
function tidy(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= ALT_TEXT_SUGGESTION_MAX) {
    return line;
  }
  const cut = line.slice(0, ALT_TEXT_SUGGESTION_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > ALT_TEXT_SUGGESTION_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

export class SuggestAltText {
  private readonly render: RenderRendition;

  constructor(
    private readonly deps: AiDependencies,
    private readonly media: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'processor' | 'ids'>,
  ) {
    this.render = new RenderRendition(media);
  }

  async execute(command: SuggestAltTextCommand): Promise<string> {
    const { actor } = command;
    assertCanWrite(actor);
    const scope = scopeOf(actor);
    const { language, effort } = await this.deps.unitOfWork.run(scope, async (store) => ({
      language: command.language ?? (await store.workspaces.languageOf(actor.workspaceId)),
      effort: await effortOf(store, actor.workspaceId, 'altText', this.deps.efforts),
    }));
    // Made once per asset and kept, like every rendition.
    const rendition = await this.render.execute({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      assetId: command.assetId,
      profile: 'ai_vision',
      crop: null,
      letterbox: false,
    });
    const bytes = await this.media.storage.get(rendition.storageKey, {
      maxBytes: RENDITION_PROFILES.ai_vision.maxBytes,
    });
    const context = command.context?.trim() ?? '';
    const input: SuggestAltTextInput = {
      language,
      image: { kind: 'base64', mediaType: 'image/jpeg', data: toBase64(bytes) },
      context: context.length > 0 ? context : null,
    };
    const call = await startMeteredCall(
      this.deps,
      {
        scope,
        task: 'ALT_TEXT',
        postId: null,
        brandVoiceVersionId: null,
        effort,
        // Ids and sizes only: neither the image nor the context goes into the log.
        input: { assetId: command.assetId, language, withContext: input.context !== null },
      },
      this.deps.estimator.estimate({ task: 'altText', input }),
    );

    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let suggestion: string | null = null;
    try {
      const result = await this.deps.provider
        .suggestAltText(input, { effort, ...(command.signal ? { signal: command.signal } : {}) })
        .catch((error: unknown) => {
          failure = unexpectedFailure(error);
          throw error;
        });
      report = result.report;
      if (!result.ok) {
        failure = result.failure;
        throw new AiCallFailedError(result.failure);
      }
      suggestion = tidy(result.value);
      return suggestion;
    } finally {
      await call.finish({
        report,
        outcome: outcomeOf(failure, suggestion !== null),
        output: suggestion === null ? null : { altText: suggestion },
      });
    }
  }
}
