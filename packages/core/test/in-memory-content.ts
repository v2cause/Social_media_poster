import type {
  AuditEntry,
  BrandProfile,
  BrandVoice,
  BrandVoiceVersion,
  Clock,
  ContentActor,
  ContentDependencies,
  ContentScope,
  ContentStore,
  ContentUnitOfWork,
  IdGenerator,
  Idea,
  IdeaStatus,
  Post,
  PostStyle,
  PostVariant,
} from '../src';

// An in-memory unit of work for the content use cases. Like row-level security, it hides rows of
// other workspaces and rejects writes outside the scope, and it rolls back on errors.

interface State {
  posts: Map<string, Post>;
  variants: Map<string, PostVariant>;
  styles: Map<string, PostStyle>;
  voices: Map<string, BrandVoice>;
  versions: BrandVoiceVersion[];
  ideas: Map<string, Idea>;
  profiles: Map<string, BrandProfile>;
  efforts: Map<string, Record<string, string>>;
  audit: AuditEntry[];
}

export class ScopeViolation extends Error {}

const emptyState = (): State => ({
  posts: new Map(),
  variants: new Map(),
  styles: new Map(),
  voices: new Map(),
  versions: [],
  ideas: new Map(),
  profiles: new Map(),
  efforts: new Map(),
  audit: [],
});

export const PRESET_STYLE: PostStyle = {
  id: 'style-professional',
  workspaceId: null,
  key: 'professional',
  name: 'Professional',
  instructions: 'Clear and factual.',
  isActive: true,
  sortOrder: 0,
  version: 0,
};

/** Similar titles: the same words, ignoring case; enough for the use case tests. */
const similar = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export class InMemoryContent implements ContentUnitOfWork {
  state: State = emptyState();
  readonly scopes: ContentScope[] = [];

  constructor() {
    this.state.styles.set(PRESET_STYLE.id, PRESET_STYLE);
  }

  async run<T>(scope: ContentScope, work: (store: ContentStore) => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private storeFor(scope: ContentScope): ContentStore {
    const state = (): State => this.state;
    const inScope = (workspaceId: string | null): boolean => workspaceId === scope.workspaceId;
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    const visible = <T extends { workspaceId: string }>(
      map: Map<string, T>,
      workspaceId: string,
      id: string,
    ) => {
      assertScope(workspaceId);
      const row = map.get(id);
      return row && inScope(row.workspaceId) ? row : null;
    };
    /** A conditional update: the row must exist in scope with the version; raises the version. */
    const update = <T extends { workspaceId: string | null; version: number }>(
      map: Map<string, T>,
      workspaceId: string,
      id: string,
      version: number,
      patch: NoInfer<Partial<T>>,
    ): boolean => {
      assertScope(workspaceId);
      const row = map.get(id);
      if (!row || !inScope(row.workspaceId) || row.version !== version) {
        return false;
      }
      map.set(id, { ...row, ...patch, version: version + 1 });
      return true;
    };

    return {
      posts: {
        find: (workspaceId, postId) => Promise.resolve(visible(state().posts, workspaceId, postId)),
        insert: (post) => {
          assertScope(post.workspaceId);
          state().posts.set(post.id, post);
          return Promise.resolve();
        },
        update: (workspaceId, postId, version, patch) =>
          Promise.resolve(update(state().posts, workspaceId, postId, version, patch)),
        touch: (workspaceId, postId, version) =>
          Promise.resolve(update(state().posts, workspaceId, postId, version, {})),
        delete: (workspaceId, postId) => {
          assertScope(workspaceId);
          state().posts.delete(postId);
          for (const [id, variant] of state().variants) {
            if (variant.postId === postId) {
              state().variants.delete(id);
            }
          }
          return Promise.resolve();
        },
      },
      variants: {
        find: (workspaceId, variantId) => Promise.resolve(visible(state().variants, workspaceId, variantId)),
        ofPost: (workspaceId, postId) => {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().variants.values()]
              .filter((variant) => variant.postId === postId && inScope(variant.workspaceId))
              .sort((a, b) => a.targetKey.localeCompare(b.targetKey, 'en', { numeric: true })),
          );
        },
        insertMany: (variants) => {
          for (const variant of variants) {
            assertScope(variant.workspaceId);
            state().variants.set(variant.id, variant);
          }
          return Promise.resolve();
        },
        update: (workspaceId, variantId, version, patch) =>
          Promise.resolve(update(state().variants, workspaceId, variantId, version, patch)),
        deleteMany: (workspaceId, variantIds) => {
          assertScope(workspaceId);
          for (const id of variantIds) {
            state().variants.delete(id);
          }
          return Promise.resolve();
        },
      },
      styles: {
        find: (workspaceId, styleId) => {
          assertScope(workspaceId);
          const style = state().styles.get(styleId);
          return Promise.resolve(
            style && (style.workspaceId === null || inScope(style.workspaceId)) ? style : null,
          );
        },
        keyTaken: (workspaceId, key, excludeStyleId) => {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().styles.values()].some(
              (style) =>
                style.workspaceId === workspaceId && style.key === key && style.id !== excludeStyleId,
            ),
          );
        },
        nextSortOrder: (workspaceId) => {
          assertScope(workspaceId);
          const orders = [...state().styles.values()]
            .filter((style) => style.workspaceId === workspaceId)
            .map((style) => style.sortOrder);
          return Promise.resolve(orders.length === 0 ? 0 : Math.max(...orders) + 1);
        },
        insert: (style) => {
          assertScope(style.workspaceId ?? '');
          state().styles.set(style.id, style);
          return Promise.resolve();
        },
        update: (workspaceId, styleId, version, patch) =>
          Promise.resolve(update(state().styles, workspaceId, styleId, version, patch)),
        activeCustom: (workspaceId) => {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().styles.values()]
              .filter((style) => style.workspaceId === workspaceId && style.isActive)
              .sort((a, b) => a.sortOrder - b.sortOrder),
          );
        },
      },
      brandVoices: {
        find: (workspaceId, brandVoiceId) =>
          Promise.resolve(visible(state().voices, workspaceId, brandVoiceId)),
        findDefault: (workspaceId) => {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().voices.values()].find(
              (voice) => inScope(voice.workspaceId) && voice.isDefault && voice.archivedAt === null,
            ) ?? null,
          );
        },
        insert: (voice, firstVersion) => {
          assertScope(voice.workspaceId);
          state().voices.set(voice.id, voice);
          state().versions.push(firstVersion);
          return Promise.resolve();
        },
        update: (workspaceId, brandVoiceId, version, patch) =>
          Promise.resolve(update(state().voices, workspaceId, brandVoiceId, version, patch)),
        clearDefault: (workspaceId, exceptBrandVoiceId) => {
          assertScope(workspaceId);
          for (const [id, voice] of state().voices) {
            if (inScope(voice.workspaceId) && id !== exceptBrandVoiceId && voice.isDefault) {
              state().voices.set(id, { ...voice, isDefault: false });
            }
          }
          return Promise.resolve();
        },
        addVersion: (version) => {
          assertScope(version.workspaceId);
          state().versions.push(version);
          return Promise.resolve();
        },
        findVersion: (workspaceId, brandVoiceId, versionNumber) => {
          assertScope(workspaceId);
          return Promise.resolve(
            state().versions.find(
              (version) =>
                inScope(version.workspaceId) &&
                version.brandVoiceId === brandVoiceId &&
                version.versionNumber === versionNumber,
            ) ?? null,
          );
        },
      },
      ideas: {
        find: (workspaceId, ideaId) => Promise.resolve(visible(state().ideas, workspaceId, ideaId)),
        insertMany: (ideas) => {
          for (const idea of ideas) {
            assertScope(idea.workspaceId);
            state().ideas.set(idea.id, idea);
          }
          return Promise.resolve();
        },
        update: (workspaceId, ideaId, version, patch) =>
          Promise.resolve(update(state().ideas, workspaceId, ideaId, version, patch)),
        setStatus: (workspaceId, ideaId, status: IdeaStatus) => {
          const idea = visible(state().ideas, workspaceId, ideaId);
          if (idea) {
            state().ideas.set(ideaId, { ...idea, status, version: idea.version + 1 });
          }
          return Promise.resolve();
        },
        similarTitles: (workspaceId, titles) => {
          assertScope(workspaceId);
          const existing = [...state().ideas.values()].filter((idea) => inScope(idea.workspaceId));
          return Promise.resolve(
            titles.filter((title) => existing.some((idea) => similar(idea.title, title))),
          );
        },
        recentTitles: (workspaceId, status, limit) => {
          assertScope(workspaceId);
          return Promise.resolve(
            [...state().ideas.values()]
              .filter((idea) => inScope(idea.workspaceId) && idea.status === status)
              .map((idea) => idea.title)
              .reverse()
              .slice(0, limit),
          );
        },
      },
      workspaces: {
        profileOf: (workspaceId) => {
          assertScope(workspaceId);
          return Promise.resolve(
            state().profiles.get(workspaceId) ?? {
              name: 'Acme',
              industry: null,
              targetAudience: null,
              goals: null,
              contentPillars: [],
            },
          );
        },
        effortOverridesOf: (workspaceId) => {
          assertScope(workspaceId);
          return Promise.resolve(state().efforts.get(workspaceId) ?? null);
        },
      },
      audit: {
        record: (entry) => {
          if (entry.organizationId !== scope.organizationId) {
            throw new ScopeViolation('audit entry outside the organization');
          }
          state().audit.push(entry);
          return Promise.resolve();
        },
      },
    };
  }
}

/** Ids in creation order, readable in failures. */
export const sequentialIds = (prefix = 'id'): IdGenerator => {
  let next = 0;
  return { newId: () => `${prefix}-${String((next += 1))}` };
};

export const fixedClock = (iso = '2026-10-16T12:00:00Z'): Clock => ({ now: () => new Date(iso) });

export interface ContentTestbed extends ContentDependencies {
  unitOfWork: InMemoryContent;
}

export const createContentTestbed = (): ContentTestbed => ({
  unitOfWork: new InMemoryContent(),
  clock: fixedClock(),
  ids: sequentialIds(),
});

export const actorOf = (role: ContentActor['role'] = 'EDITOR', workspaceId = 'ws-1'): ContentActor => ({
  userId: `user-${role.toLowerCase()}`,
  organizationId: 'org-1',
  workspaceId,
  role,
});
