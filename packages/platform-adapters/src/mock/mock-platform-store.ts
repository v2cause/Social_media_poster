// What the mock platforms remember: published posts and the calls per account. The chaos test of
// guide step 4.8 counts the publish calls here, so it must outlive one worker; tests share one
// store between the worker they stop and the one they start.

export interface MockPost {
  externalPostId: string;
  /** The SocialAccount the post went out for. */
  accountId: string;
  text: string;
  contentHash: string;
  publishedAt: Date;
  deletedAt: Date | null;
}

export class InMemoryMockPlatformStore {
  private readonly posts = new Map<string, MockPost>();
  private readonly calls = new Map<string, number>();
  private readonly flags = new Set<string>();

  countCall(operation: string, accountId: string): void {
    const key = `${operation}:${accountId}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
  }

  /** How often an operation ran for an account, for example publish. */
  callCount(operation: string, accountId: string): number {
    return this.calls.get(`${operation}:${accountId}`) ?? 0;
  }

  /** Sets a flag once; true when it was not set yet. */
  setOnce(flag: string): boolean {
    if (this.flags.has(flag)) {
      return false;
    }
    this.flags.add(flag);
    return true;
  }

  save(post: MockPost): void {
    this.posts.set(post.externalPostId, post);
  }

  find(externalPostId: string): MockPost | undefined {
    return this.posts.get(externalPostId);
  }

  postsOf(accountId: string): MockPost[] {
    return [...this.posts.values()].filter((post) => post.accountId === accountId);
  }
}
