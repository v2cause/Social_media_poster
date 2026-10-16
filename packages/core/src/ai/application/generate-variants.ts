import { assertCanWrite, scopeOf } from '../../content/application/dependencies';
import { BriefRequiredError, PostNotFoundError, VariantNotFoundError } from '../../content/domain/errors';
import type { ContentActor, PostVariant } from '../../content/domain/types';
import { QuotaExceededError } from '../../usage/domain/errors';
import type { AiCallReport, AiEffort, AiFailure, GeneratedVariant } from '../domain/types';
import type { GenerateVariantsInput, RefineVariantInput } from '../ports/ai-provider';
import {
  brandOf,
  effortOf,
  outcomeOf,
  startMeteredCall,
  unexpectedFailure,
  type AiDependencies,
  type LoadedBrand,
} from './ai-dependencies';
import { checkVariant, countOf, type GenerationEvent, type GeneratedVariantResult } from './variant-results';

// Generates the variants of a post with the AI (guide step 2.7, architecture 5.3). Loading and
// the quota reservation happen before the first event, so their errors (404, 402, 422) reach
// the client as an HTTP error. From the first event on, every failure is a generation.failed
// event. The variants are not saved: the editor takes them over where the user has not edited.

/** The style when the post names none. */
export const DEFAULT_STYLE_KEY = 'professional';

export interface GenerateVariantsCommand {
  actor: ContentActor;
  postId: string;
  /** Only these variants of the post; all when missing. */
  variantIds?: readonly string[];
  /** Aborts the call, for example when the client disconnects. */
  signal?: AbortSignal;
}

interface LoadedPost {
  brief: string;
  language: GenerateVariantsInput['language'];
  styleKey: string;
  variants: PostVariant[];
  brand: LoadedBrand;
  effort: AiEffort;
  refineEffort: AiEffort;
}

export class GenerateVariants {
  constructor(private readonly deps: AiDependencies) {}

  async *execute(command: GenerateVariantsCommand): AsyncGenerator<GenerationEvent> {
    const { actor } = command;
    assertCanWrite(actor);
    const scope = scopeOf(actor);
    const loaded = await this.load(command);
    const input: GenerateVariantsInput = {
      brand: loaded.brand.context,
      styleKey: loaded.styleKey,
      targets: loaded.variants.map((variant) => ({ key: variant.targetKey, platform: variant.platform })),
      language: loaded.language,
      brief: loaded.brief,
      mediaDescriptions: [],
    };
    const call = await startMeteredCall(
      this.deps,
      {
        scope,
        task: 'GENERATE',
        postId: command.postId,
        brandVoiceVersionId: loaded.brand.brandVoiceVersionId,
        effort: loaded.effort,
        input: {
          brief: input.brief,
          styleKey: input.styleKey,
          language: input.language,
          targets: input.targets,
        },
      },
      this.deps.estimator.estimate({ task: 'generate', input }),
    );

    const { generationId } = call;
    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let generated: GeneratedVariant[] | null = null;
    try {
      yield { type: 'generation.started', generationId };
      for await (const event of this.deps.provider.generateVariants(input, {
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
          generated = event.variants;
        }
      }
      if (failure || !generated) {
        failure ??= unexpectedFailure(new Error('stream ended without a result'));
        yield { type: 'generation.failed', generationId, code: failure.code, retryable: failure.retryable };
        return;
      }
      await call.finish({ report, outcome: 'OK', output: generated });
      const variants = await this.checked(generated, loaded, input, command);
      yield { type: 'generation.completed', generationId, variants };
    } catch (error) {
      failure ??= unexpectedFailure(error);
      this.deps.warn?.('ai.generation_error', {
        generationId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      yield { type: 'generation.failed', generationId, code: failure.code, retryable: failure.retryable };
    } finally {
      await call.finish({ report, outcome: outcomeOf(failure, generated !== null), output: generated });
    }
  }

  private load(command: GenerateVariantsCommand): Promise<LoadedPost> {
    const { actor } = command;
    return this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const post = await store.posts.find(actor.workspaceId, command.postId);
      if (!post) {
        throw new PostNotFoundError();
      }
      if (post.brief.trim().length === 0) {
        throw new BriefRequiredError();
      }
      const all = await store.variants.ofPost(actor.workspaceId, post.id);
      const variants = command.variantIds
        ? all.filter((variant) => command.variantIds?.includes(variant.id))
        : all;
      if (
        variants.length === 0 ||
        (command.variantIds && variants.length !== new Set(command.variantIds).size)
      ) {
        throw new VariantNotFoundError();
      }
      const style = post.styleId ? await store.styles.find(actor.workspaceId, post.styleId) : null;
      return {
        brief: post.brief,
        language: post.language,
        styleKey: style?.key ?? DEFAULT_STYLE_KEY,
        variants,
        brand: await brandOf(store, actor.workspaceId, post.brandVoiceId),
        effort: await effortOf(store, actor.workspaceId, 'generate', this.deps.efforts),
        refineEffort: await effortOf(store, actor.workspaceId, 'refine', this.deps.efforts),
      };
    });
  }

  /** Counts and checks every variant; one that is too long is shortened once automatically. */
  private async checked(
    generated: readonly GeneratedVariant[],
    loaded: LoadedPost,
    input: GenerateVariantsInput,
    command: GenerateVariantsCommand,
  ): Promise<GeneratedVariantResult[]> {
    const forbiddenWords = loaded.brand.context.voice?.forbiddenWords ?? [];
    const results: GeneratedVariantResult[] = [];
    for (const variant of generated) {
      const stored = loaded.variants.find((candidate) => candidate.targetKey === variant.targetKey);
      if (!stored) {
        continue;
      }
      const shortened = countOf(variant).overLimit
        ? await this.shorten(variant, loaded, input, command)
        : null;
      results.push(
        checkVariant(shortened ?? variant, {
          variantId: stored.id,
          forbiddenWords,
          autoShortened: shortened !== null,
        }),
      );
    }
    return results;
  }

  /** One metered refinement "shorter"; null when it fails or the quota does not cover it. */
  private async shorten(
    variant: GeneratedVariant,
    loaded: LoadedPost,
    generateInput: GenerateVariantsInput,
    command: GenerateVariantsCommand,
  ): Promise<GeneratedVariant | null> {
    const input: RefineVariantInput = {
      brand: generateInput.brand,
      styleKey: generateInput.styleKey,
      target: { key: variant.targetKey, platform: variant.platform },
      language: generateInput.language,
      action: 'shorter',
      instruction: null,
      variant: { text: variant.text, hashtags: variant.hashtags, firstComment: variant.firstComment },
    };
    let call;
    try {
      call = await startMeteredCall(
        this.deps,
        {
          scope: scopeOf(command.actor),
          task: 'REFINE',
          postId: command.postId,
          brandVoiceVersionId: loaded.brand.brandVoiceVersionId,
          effort: loaded.refineEffort,
          input: { action: 'shorter', automatic: true, target: input.target, language: input.language },
        },
        this.deps.estimator.estimate({ task: 'refine', input }),
      );
    } catch (error) {
      // Without a reservation the variant stays as it is; the editor marks it as too long.
      if (!(error instanceof QuotaExceededError)) {
        this.deps.warn?.('ai.auto_shorten_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
      return null;
    }

    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let result: GeneratedVariant | null = null;
    try {
      for await (const event of this.deps.provider.refineVariant(input, {
        effort: loaded.refineEffort,
        ...(command.signal ? { signal: command.signal } : {}),
      })) {
        if (event.type === 'failed') {
          report = event.report;
          failure = event.failure;
        } else if (event.type === 'completed') {
          report = event.report;
          result = event.variants[0] ?? null;
        }
      }
    } catch (error) {
      failure = unexpectedFailure(error);
    } finally {
      await call.finish({ report, outcome: outcomeOf(failure, result !== null), output: result });
    }
    return result && !countOf(result).overLimit ? result : null;
  }
}
