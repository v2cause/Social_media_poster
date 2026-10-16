import type { ContentScope, ContentStore, ContentUnitOfWork } from '../../content/ports/content-store';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import type { QuotaReservation, QuotaService } from '../../usage/application/quota-service';
import {
  AI_EFFORTS,
  type AiCallReport,
  type AiEffort,
  type AiFailure,
  type AiRoute,
  type BrandContext,
} from '../domain/types';
import type { AiProvider } from '../ports/ai-provider';
import type { AiGenerationLog, AiOutcome, AiTask } from '../ports/ai-generation-log';
import type { AiUsageEstimator, TokenEstimate } from '../ports/ai-usage-estimator';
import type { CostCalculator } from './cost-calculator';

// What the AI use cases share (guide step 2.7): the brand context of a workspace, the effort of
// a route and the metering of a call. Every call reserves its estimate before it starts and books
// its actual cost, its AiGeneration and the quota at its end, also after errors and aborts.

export type AiWarn = (message: string, fields: Record<string, unknown>) => void;

export interface AiDependencies {
  unitOfWork: ContentUnitOfWork;
  provider: AiProvider;
  estimator: AiUsageEstimator;
  quota: QuotaService;
  costs: CostCalculator;
  log: AiGenerationLog;
  clock: Clock;
  ids: IdGenerator;
  /** AI_MODEL: the model the estimate is priced at. */
  model: string;
  /** The effort per route from the environment; a workspace can override it. */
  efforts: Readonly<Record<AiRoute, AiEffort>>;
  /** For problems that must not fail the call, such as a missing price. Never with content. */
  warn?: AiWarn;
}

// The workspace settings name the routes in snake case (contracts, AI_ROUTES).
const SETTINGS_KEY: Readonly<Record<AiRoute, string>> = {
  generate: 'generate',
  refine: 'refine',
  ideas: 'ideas',
  altText: 'alt_text',
};

const isEffort = (value: string | undefined): value is AiEffort =>
  value !== undefined && (AI_EFFORTS as readonly string[]).includes(value);

/** The effort of a route: the workspace's override, or the default of the environment. */
export async function effortOf(
  store: ContentStore,
  workspaceId: string,
  route: AiRoute,
  defaults: Readonly<Record<AiRoute, AiEffort>>,
): Promise<AiEffort> {
  const override = (await store.workspaces.effortOverridesOf(workspaceId))?.[SETTINGS_KEY[route]];
  return isEffort(override) ? override : defaults[route];
}

export interface LoadedBrand {
  context: BrandContext;
  /** The version the call uses, stored with its AiGeneration. */
  brandVoiceVersionId: string | null;
}

/** Layer 2 of the prompt: company profile, the current version of the voice, custom styles. */
export async function brandOf(
  store: ContentStore,
  workspaceId: string,
  brandVoiceId: string | null,
): Promise<LoadedBrand> {
  const profile = await store.workspaces.profileOf(workspaceId);
  const voice = brandVoiceId ? await store.brandVoices.find(workspaceId, brandVoiceId) : null;
  const version = voice
    ? await store.brandVoices.findVersion(workspaceId, voice.id, voice.currentVersionNumber)
    : null;
  const customStyles = (await store.styles.activeCustom(workspaceId)).map((style) => ({
    key: style.key,
    name: style.name,
    instructions: style.instructions,
  }));
  return {
    context: { profile, voice: version?.content ?? null, customStyles },
    brandVoiceVersionId: version?.id ?? null,
  };
}

/** An error the provider did not map, recorded as PROVIDER_ERROR without its message. */
export const unexpectedFailure = (error: unknown): AiFailure => ({
  code: 'PROVIDER_ERROR',
  retryable: true,
  detail: `unexpected error: ${error instanceof Error ? error.name : 'unknown'}`,
  refusalCategory: null,
  status: null,
});

/** The outcome of a call for its AiGeneration. */
export const outcomeOf = (failure: AiFailure | null, completed: boolean): AiOutcome =>
  failure ? failure.code : completed ? 'OK' : 'CANCELED';

interface CallBasics {
  scope: ContentScope;
  task: AiTask;
  postId: string | null;
  brandVoiceVersionId: string | null;
  effort: AiEffort;
  input: Record<string, unknown>;
}

/** A call whose estimate is reserved. finish() books it once, whatever happened. */
export class MeteredCall {
  private finished = false;

  constructor(
    private readonly deps: AiDependencies,
    private readonly reservation: QuotaReservation,
    private readonly basics: CallBasics,
    readonly generationId: string,
  ) {}

  async finish(result: { report: AiCallReport | null; outcome: AiOutcome; output: unknown }): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const { deps, basics } = this;
    const warn: AiWarn = deps.warn ?? (() => undefined);

    // Without a report no model ran. Without a price the reservation counts, so a failure of the
    // price lookup never makes a call free.
    let costMicros = 0n;
    if (result.report) {
      try {
        const cost = await deps.costs.costOf(result.report);
        costMicros = cost.costMicros;
        if (cost.unpricedModels.length > 0) {
          warn('ai.unpriced_models', { models: cost.unpricedModels });
        }
      } catch (error) {
        costMicros = this.reservation.reserved;
        warn('ai.cost_failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
    }
    try {
      await deps.log.record({
        id: this.generationId,
        organizationId: basics.scope.organizationId,
        workspaceId: basics.scope.workspaceId,
        userId: basics.scope.userId,
        task: basics.task,
        postId: basics.postId,
        brandVoiceVersionId: basics.brandVoiceVersionId,
        report: result.report,
        provider: deps.provider.name,
        promptVersion: deps.provider.promptVersion,
        modelRequested: deps.model,
        effort: basics.effort,
        input: basics.input,
        output: result.output,
        outcome: result.outcome,
        costMicros,
      });
    } catch (error) {
      warn('ai.generation_log_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
    try {
      await this.reservation.finalize({
        quantity: costMicros,
        sourceType: 'ai_generation',
        sourceId: this.generationId,
      });
    } catch (error) {
      warn('ai.quota_finalize_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
}

/** Reserves the estimate of a call; throws QuotaExceededError when the quota does not cover it. */
export async function startMeteredCall(
  deps: AiDependencies,
  basics: CallBasics,
  estimate: TokenEstimate,
): Promise<MeteredCall> {
  const amount = await deps.costs.estimateMicros(deps.model, estimate);
  const reservation = await deps.quota.reserve(
    { organizationId: basics.scope.organizationId, workspaceId: basics.scope.workspaceId },
    'ai_micros',
    amount,
  );
  return new MeteredCall(deps, reservation, basics, deps.ids.newId());
}
