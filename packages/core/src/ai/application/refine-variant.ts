import { assertCanWrite, scopeOf } from '../../content/application/dependencies';
import { PostNotFoundError, VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import type {
  AiCallReport,
  AiFailure,
  ContentLanguage,
  GeneratedVariant,
  RefineAction,
} from '../domain/types';
import type { RefineVariantInput } from '../ports/ai-provider';
import {
  brandOf,
  effortOf,
  outcomeOf,
  startMeteredCall,
  unexpectedFailure,
  type AiDependencies,
} from './ai-dependencies';
import { DEFAULT_STYLE_KEY } from './generate-variants';
import { checkVariant, type GenerationEvent } from './variant-results';

// Refines one variant with a quick action or the user's own instruction (guide step 2.7). Every
// action is a stateless call with the same cached prompt prefix. The result is not saved: the
// editor shows a diff and saves it when the user takes it over.

export interface RefineVariantCommand {
  actor: ContentActor;
  variantId: string;
  action: RefineAction;
  /** The request of action "custom". */
  instruction: string | null;
  /** The target language of action "translate"; the post's language otherwise. */
  language: ContentLanguage | null;
  /** The variant as the editor shows it, saved or not. */
  current: { text: string; hashtags: string[]; firstComment: string | null };
  signal?: AbortSignal;
}

export class RefineVariant {
  constructor(private readonly deps: AiDependencies) {}

  async *execute(command: RefineVariantCommand): AsyncGenerator<GenerationEvent> {
    const { actor } = command;
    assertCanWrite(actor);
    const scope = scopeOf(actor);
    const loaded = await this.deps.unitOfWork.run(scope, async (store) => {
      const variant = await store.variants.find(actor.workspaceId, command.variantId);
      if (!variant) {
        throw new VariantNotFoundError();
      }
      const post = await store.posts.find(actor.workspaceId, variant.postId);
      if (!post) {
        throw new PostNotFoundError();
      }
      const style = post.styleId ? await store.styles.find(actor.workspaceId, post.styleId) : null;
      return {
        variant,
        post,
        styleKey: style?.key ?? DEFAULT_STYLE_KEY,
        brand: await brandOf(store, actor.workspaceId, post.brandVoiceId),
        effort: await effortOf(store, actor.workspaceId, 'refine', this.deps.efforts),
      };
    });
    const input: RefineVariantInput = {
      brand: loaded.brand.context,
      styleKey: loaded.styleKey,
      target: { key: loaded.variant.targetKey, platform: loaded.variant.platform },
      language: command.action === 'translate' && command.language ? command.language : loaded.post.language,
      action: command.action,
      instruction: command.action === 'custom' ? command.instruction : null,
      variant: command.current,
    };
    const call = await startMeteredCall(
      this.deps,
      {
        scope,
        task: 'REFINE',
        postId: loaded.post.id,
        brandVoiceVersionId: loaded.brand.brandVoiceVersionId,
        effort: loaded.effort,
        input: {
          action: input.action,
          instruction: input.instruction,
          language: input.language,
          styleKey: input.styleKey,
          target: input.target,
          variant: input.variant,
        },
      },
      this.deps.estimator.estimate({ task: 'refine', input }),
    );

    const { generationId } = call;
    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let refined: GeneratedVariant | null = null;
    try {
      yield { type: 'generation.started', generationId };
      for await (const event of this.deps.provider.refineVariant(input, {
        effort: loaded.effort,
        ...(command.signal ? { signal: command.signal } : {}),
      })) {
        if (event.type === 'partial') {
          yield { type: 'variant.partial', variants: event.variants };
        } else if (event.type === 'reset') {
          yield { type: 'variant.reset' };
        } else if (event.type === 'failed') {
          report = event.report;
          failure = event.failure;
        } else {
          report = event.report;
          refined = event.variants[0] ?? null;
        }
      }
      if (failure || !refined) {
        failure ??= {
          code: 'INVALID_OUTPUT',
          retryable: false,
          detail: 'the refinement returned no variant',
          refusalCategory: null,
          status: null,
        };
        yield { type: 'generation.failed', generationId, code: failure.code, retryable: failure.retryable };
        return;
      }
      const result = checkVariant(refined, {
        variantId: loaded.variant.id,
        forbiddenWords: loaded.brand.context.voice?.forbiddenWords ?? [],
        autoShortened: false,
      });
      yield { type: 'generation.completed', generationId, variants: [result] };
    } catch (error) {
      failure ??= unexpectedFailure(error);
      this.deps.warn?.('ai.refinement_error', {
        generationId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      yield { type: 'generation.failed', generationId, code: failure.code, retryable: failure.retryable };
    } finally {
      await call.finish({ report, outcome: outcomeOf(failure, refined !== null), output: refined });
    }
  }
}
