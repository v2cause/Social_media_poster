import { assertCanManageBrand, scopeOf } from '../../content/application/dependencies';
import { BrandVoiceNotFoundError } from '../../content/domain/errors';
import type { ContentActor } from '../../content/domain/types';
import { AiCallFailedError } from '../domain/errors';
import type { AiCallReport, AiFailure, ContentLanguage, GeneratedVariant } from '../domain/types';
import type { GenerateVariantsInput } from '../ports/ai-provider';
import {
  brandOf,
  effortOf,
  outcomeOf,
  startMeteredCall,
  unexpectedFailure,
  type AiDependencies,
} from './ai-dependencies';
import { DEFAULT_STYLE_KEY } from './generate-variants';
import { checkContent, type GeneratedVariantResult } from './variant-results';

// "Test voice" on the brand voice page (guide step 2.9): a sample LinkedIn post in the current
// version of the voice. It counts against the AI quota like every call.

/** The brief of the sample post when the user gives none. */
export const SAMPLE_BRIEFS: Readonly<Record<ContentLanguage, string>> = {
  de: 'Stellen Sie unser Unternehmen und das, was uns ausmacht, in einem kurzen Beitrag vor.',
  en: 'Introduce our company and what makes us different in a short post.',
};

export interface TestBrandVoiceCommand {
  actor: ContentActor;
  brandVoiceId: string;
  brief: string | null;
  signal?: AbortSignal;
}

export interface TestBrandVoiceResult {
  generationId: string;
  variant: Omit<GeneratedVariantResult, 'variantId'>;
}

export class TestBrandVoice {
  constructor(private readonly deps: AiDependencies) {}

  async execute(command: TestBrandVoiceCommand): Promise<TestBrandVoiceResult> {
    const { actor } = command;
    assertCanManageBrand(actor);
    const scope = scopeOf(actor);
    const loaded = await this.deps.unitOfWork.run(scope, async (store) => {
      const voice = await store.brandVoices.find(actor.workspaceId, command.brandVoiceId);
      if (!voice) {
        throw new BrandVoiceNotFoundError();
      }
      const brand = await brandOf(store, actor.workspaceId, voice.id);
      return {
        brand,
        language: brand.context.voice?.language ?? (await store.workspaces.languageOf(actor.workspaceId)),
        effort: await effortOf(store, actor.workspaceId, 'generate', this.deps.efforts),
      };
    });
    const brief = command.brief?.trim();
    const input: GenerateVariantsInput = {
      brand: loaded.brand.context,
      styleKey: DEFAULT_STYLE_KEY,
      targets: [{ key: 't1', platform: 'LINKEDIN' }],
      language: loaded.language,
      brief: brief && brief.length > 0 ? brief : SAMPLE_BRIEFS[loaded.language],
      mediaDescriptions: [],
    };
    const call = await startMeteredCall(
      this.deps,
      {
        scope,
        task: 'VOICE_TEST',
        postId: null,
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

    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let variant: GeneratedVariant | null = null;
    try {
      try {
        for await (const event of this.deps.provider.generateVariants(input, {
          effort: loaded.effort,
          ...(command.signal ? { signal: command.signal } : {}),
        })) {
          if (event.type === 'failed') {
            report = event.report;
            failure = event.failure;
          } else if (event.type === 'completed') {
            report = event.report;
            variant = event.variants[0] ?? null;
          }
        }
      } catch (error) {
        failure = unexpectedFailure(error);
        throw error;
      }
      if (failure || !variant) {
        failure ??= {
          code: 'INVALID_OUTPUT',
          retryable: false,
          detail: 'the test returned no variant',
          refusalCategory: null,
          status: null,
        };
        throw new AiCallFailedError(failure);
      }
      const checked = checkContent(variant, {
        forbiddenWords: loaded.brand.context.voice?.forbiddenWords ?? [],
        autoShortened: false,
      });
      return { generationId: call.generationId, variant: checked };
    } finally {
      await call.finish({ report, outcome: outcomeOf(failure, variant !== null), output: variant });
    }
  }
}
