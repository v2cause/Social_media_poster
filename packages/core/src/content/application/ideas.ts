import { IdeaNotFoundError } from '../domain/errors';
import type { ContentActor } from '../domain/types';
import type { IdeaPatch } from '../ports/content-store';
import {
  assertCanWrite,
  assertUpdated,
  assertVersion,
  scopeOf,
  type ContentDependencies,
} from './dependencies';

// Ideas (guide steps 2.7 and 2.9): save, discard or reword a suggestion. Discarded ideas serve as
// negative examples for the next suggestions.

export interface UpdateIdeaInput {
  actor: ContentActor;
  ideaId: string;
  version: number;
  patch: IdeaPatch;
}

export class UpdateIdea {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork'>) {}

  async execute(input: UpdateIdeaInput): Promise<void> {
    const { actor } = input;
    assertCanWrite(actor);
    await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const idea = await store.ideas.find(actor.workspaceId, input.ideaId);
      if (!idea) {
        throw new IdeaNotFoundError();
      }
      assertVersion(idea.version, input.version);
      assertUpdated(await store.ideas.update(actor.workspaceId, idea.id, input.version, input.patch));
    });
  }
}
