import type { Page } from 'playwright';

// The form of a selector map (guide step 6.3): locators by data-testid, by ARIA role and name or,
// where X offers neither, by CSS; the URLs of the JSON answers the flows read; the steps of the
// login by the ids of their subtasks. A new interface of X gets a new map next to the old one.

export type AriaRole = Parameters<Page['getByRole']>[0];

export type Selector = { testId: string } | { role: AriaRole; name?: string | RegExp } | { css: string };

export interface SelectorMap {
  readonly version: string;
  readonly origin: string;
  /** The hosts the web app loads from, for the egress policy. */
  readonly hosts: readonly string[];
  readonly paths: { readonly login: string; readonly home: string; readonly compose: string };
  readonly login: { readonly username: Selector; readonly password: Selector; readonly code: Selector };
  readonly session: { readonly signedIn: Selector };
  readonly composer: {
    readonly textbox: Selector;
    readonly fileInput: Selector;
    readonly submit: Selector;
    readonly altText: { readonly open: Selector; readonly input: Selector; readonly save: Selector };
  };
  readonly post: { readonly menu: Selector; readonly delete: Selector; readonly confirmDelete: Selector };
  readonly challenge: { readonly urlPatterns: readonly RegExp[]; readonly elements: readonly Selector[] };
  readonly network: {
    readonly onboarding: RegExp;
    readonly viewer: RegExp;
    readonly createPost: RegExp;
    readonly deletePost: RegExp;
    readonly postDetail: RegExp;
    readonly userByScreenName: RegExp;
    readonly userPosts: RegExp;
  };
  readonly onboarding: {
    readonly username: readonly string[];
    readonly password: readonly string[];
    readonly code: readonly string[];
    readonly success: readonly string[];
    /** Steps X adds for a login it finds suspicious; the flow stops there. */
    readonly challenge: readonly string[];
    /** Steps the web app completes on its own. */
    readonly passive: readonly string[];
  };
}
