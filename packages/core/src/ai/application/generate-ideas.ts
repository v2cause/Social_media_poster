import { engagementRateOf } from '../../analytics/domain/kpis';
import { assertCanWrite, scopeOf } from '../../content/application/dependencies';
import { resolveIdeaSources } from '../../content/domain/idea-sources';
import type { ContentActor, Idea } from '../../content/domain/types';
import { AiCallFailedError } from '../domain/errors';
import type { AiCallReport, AiFailure, TopicIdea } from '../domain/types';
import type { SuggestTopicsInput, TopPostContext } from '../ports/ai-provider';
import {
  brandOf,
  effortOf,
  outcomeOf,
  startMeteredCall,
  unexpectedFailure,
  type AiDependencies,
} from './ai-dependencies';

// Topic ideas for a workspace (guide steps 2.7 and 5.6, architecture 5.3). The context: company
// profile, default brand voice, the latest posts, the top performers of the last 90 days with
// their numbers, and the discarded ideas as negative examples. An idea that names a top post by
// its ref stores the variant, so it points at a real post. New ideas that resemble existing ones
// are left out (pg_trgm in the adapter).

/** How many of the latest posts and discarded ideas the prompt gets. */
const RECENT_POSTS = 30;
const DISCARDED_IDEAS = 20;
/** The top performers: the posts with the most engagements of 90 days, seen at least 100 times. */
const TOP_POSTS = 5;
const TOP_POSTS_DAYS = 90;
const TOP_POSTS_MIN_IMPRESSIONS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GenerateIdeasCommand {
  actor: ContentActor;
  count: number;
  signal?: AbortSignal;
}

export interface GenerateIdeasResult {
  ideaIds: string[];
  /** Suggestions left out because they resembled existing ideas or each other. */
  duplicates: number;
}

export class GenerateIdeas {
  constructor(private readonly deps: AiDependencies) {}

  async execute(command: GenerateIdeasCommand): Promise<GenerateIdeasResult> {
    const { actor } = command;
    assertCanWrite(actor);
    const scope = scopeOf(actor);
    const loaded = await this.deps.unitOfWork.run(scope, async (store) => {
      const voice = await store.brandVoices.findDefault(actor.workspaceId);
      return {
        brand: await brandOf(store, actor.workspaceId, voice?.id ?? null),
        language: await store.workspaces.languageOf(actor.workspaceId),
        recentPosts: await store.posts.recentTexts(actor.workspaceId, RECENT_POSTS),
        discardedIdeas: await store.ideas.recentTitles(actor.workspaceId, 'DISCARDED', DISCARDED_IDEAS),
        topPerformers: await store.posts.topPerformers(actor.workspaceId, {
          since: new Date(this.deps.clock.now().getTime() - TOP_POSTS_DAYS * DAY_MS),
          limit: TOP_POSTS,
          minImpressions: TOP_POSTS_MIN_IMPRESSIONS,
        }),
        effort: await effortOf(store, actor.workspaceId, 'ideas', this.deps.efforts),
      };
    });
    const topPosts = loaded.topPerformers.map((post, index) => ({
      variantId: post.variantId,
      context: {
        ref: `top-${String(index + 1)}`,
        platform: post.platform,
        text: post.text,
        publishedOn: post.publishedOn,
        impressions: post.impressions,
        engagements: post.engagements,
        engagementRate: engagementRateOf([post]),
      } satisfies TopPostContext,
    }));
    const postsByRef = new Map(topPosts.map((post) => [post.context.ref, post.variantId]));
    const input: SuggestTopicsInput = {
      brand: loaded.brand.context,
      language: loaded.language,
      count: command.count,
      recentPosts: loaded.recentPosts,
      topPosts: topPosts.map((post) => post.context),
      discardedIdeas: loaded.discardedIdeas,
      // The calendar of dates comes later.
      upcomingDates: [],
    };
    const call = await startMeteredCall(
      this.deps,
      {
        scope,
        task: 'IDEAS',
        postId: null,
        brandVoiceVersionId: loaded.brand.brandVoiceVersionId,
        effort: loaded.effort,
        input: {
          count: input.count,
          language: input.language,
          recentPosts: input.recentPosts.length,
          topPosts: topPosts.map((post) => post.variantId),
          discardedIdeas: input.discardedIdeas,
        },
      },
      this.deps.estimator.estimate({ task: 'ideas', input }),
    );

    let report: AiCallReport | null = null;
    let failure: AiFailure | null = null;
    let suggested: TopicIdea[] | null = null;
    try {
      const result = await this.deps.provider
        .suggestTopics(input, {
          effort: loaded.effort,
          ...(command.signal ? { signal: command.signal } : {}),
        })
        .catch((error: unknown) => {
          failure = unexpectedFailure(error);
          throw error;
        });
      report = result.report;
      if (!result.ok) {
        failure = result.failure;
        throw new AiCallFailedError(result.failure);
      }
      suggested = result.value;
      // The ideas name their AiGeneration, so it is written first.
      await call.finish({ report, outcome: 'OK', output: suggested });
      const ideas = await this.store(actor, suggested, call.generationId, postsByRef);
      return { ideaIds: ideas.map((idea) => idea.id), duplicates: suggested.length - ideas.length };
    } finally {
      await call.finish({ report, outcome: outcomeOf(failure, suggested !== null), output: suggested });
    }
  }

  private store(
    actor: ContentActor,
    suggested: readonly TopicIdea[],
    generationId: string,
    postsByRef: ReadonlyMap<string, string>,
  ): Promise<Idea[]> {
    const seen = new Set<string>();
    const unique = suggested.filter((idea) => {
      const key = idea.title.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const similar = new Set(
        await store.ideas.similarTitles(
          actor.workspaceId,
          unique.map((idea) => idea.title),
        ),
      );
      const ideas: Idea[] = unique
        .filter((idea) => !similar.has(idea.title))
        .map((idea) => ({
          id: this.deps.ids.newId(),
          workspaceId: actor.workspaceId,
          title: idea.title,
          angle: idea.angle,
          pillar: idea.pillar,
          whyNow: idea.whyNow,
          basedOn: resolveIdeaSources(idea.basedOn, postsByRef),
          suggestedPlatforms: idea.suggestedPlatforms,
          suggestedStyleKey: idea.suggestedStyleKey,
          format: idea.format,
          status: 'NEW',
          source: 'AI',
          aiGenerationId: generationId,
          createdById: actor.userId,
          version: 0,
        }));
      await store.ideas.insertMany(ideas);
      return ideas;
    });
  }
}
