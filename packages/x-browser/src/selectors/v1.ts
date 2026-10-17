import { X_WEB_HOSTS } from '../egress';
import type { SelectorMap } from './types';

// Selector map v1 of the web app of X (architecture 4.3, guide step 6.3). Locators go by role,
// ARIA and data-testid; post ids, counters and the steps of the login come from the JSON answers
// of the web app, never from parsed HTML. When X changes its interface, only this map changes,
// as a new version next to this one.
//
// Not yet checked against the live interface: the development environment cannot reach x.com,
// so the names follow the public structure of the web app and the DOM fixtures of the tests.
// They have to be confirmed with an internal test account before the flag goes on anywhere,
// together with the hosts of the egress list.

export const selectorsV1 = {
  version: 'x-v1',
  origin: 'https://x.com',
  hosts: X_WEB_HOSTS,
  paths: { login: '/i/flow/login', home: '/home', compose: '/compose/post' },
  login: {
    username: { css: 'input[autocomplete="username"]' },
    password: { css: 'input[name="password"]' },
    code: { testId: 'ocfEnterTextTextInput' },
  },
  // Only a signed-in session shows the account switcher.
  session: { signedIn: { testId: 'SideNav_AccountSwitcher_Button' } },
  composer: {
    textbox: { testId: 'tweetTextarea_0' },
    fileInput: { testId: 'fileInput' },
    submit: { testId: 'tweetButton' },
    altText: {
      open: { testId: 'altTextLabel' },
      input: { testId: 'altTextInput' },
      save: { testId: 'endEditingButton' },
    },
  },
  post: {
    menu: { testId: 'caret' },
    // The menu item has no test id; its name follows the language of the account.
    delete: { role: 'menuitem', name: /^(Delete|Löschen)$/ },
    confirmDelete: { testId: 'confirmationSheetConfirm' },
  },
  challenge: {
    urlPatterns: [/\/account\/access\b/, /\/account\/login_challenge\b/, /\/i\/flow\/consent\b/],
    elements: [{ css: 'iframe[src*="arkoselabs"]' }, { css: 'iframe[src*="captcha"]' }],
  },
  network: {
    onboarding: /\/1\.1\/onboarding\/task\.json/,
    viewer: /\/graphql\/[^/]+\/Viewer\b/,
    createPost: /\/graphql\/[^/]+\/CreateTweet\b/,
    deletePost: /\/graphql\/[^/]+\/DeleteTweet\b/,
    postDetail: /\/graphql\/[^/]+\/(TweetDetail|TweetResultByRestId)\b/,
    userByScreenName: /\/graphql\/[^/]+\/UserByScreenName\b/,
    userPosts: /\/graphql\/[^/]+\/UserTweets\b/,
  },
  onboarding: {
    username: ['LoginEnterUserIdentifierSSO', 'LoginEnterUserIdentifier'],
    password: ['LoginEnterPassword'],
    code: ['LoginTwoFactorAuthChallenge'],
    success: ['LoginSuccessSubtask'],
    challenge: ['LoginAcid', 'LoginEnterAlternateIdentifierSubtask', 'ArkoseLogin', 'DenyLoginSubtask'],
    passive: ['LoginJsInstrumentationSubtask'],
  },
} as const satisfies SelectorMap;
