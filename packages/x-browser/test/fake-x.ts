import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page, Route } from 'playwright';

// A small stand-in for the web app of X (guide step 6.6), served through page.route: the pages
// carry the roles and test ids of selector map x-v1, their scripts ask the GraphQL and login
// endpoints like the web app does, and the answers come from test/fixtures. Requests to any
// other host fail, so nothing leaves the machine.

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

export interface FakeXOptions {
  /** Signed in from the start; a login signs in as well. */
  signedIn?: boolean;
  /** X shows a challenge: a block page instead of the composer, or a captcha on the home page. */
  challenge?: 'compose-redirect' | 'home-captcha' | null;
  /** Elements X no longer shows. */
  missing?: readonly ('tweetButton' | 'accountSwitcher' | 'fileInput')[];
  /** How X answers a post. */
  createPost?: 'ok' | 'duplicate' | 'silent' | 'rate-limited';
  /** The posts whose page shows a tombstone. */
  deletedPosts?: readonly string[];
  login?: {
    username: string;
    password: string;
    /** The code of the two-factor login; none asks for no code. */
    code?: string;
    /** A step X adds for a suspicious login. */
    challenge?: 'LoginAcid' | 'ArkoseLogin';
  };
}

export interface SentPost {
  text: string;
  media: { name: string; size: number; alt: string | null }[];
}

const html = (body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>X</title></head><body>${body}<script>${script}</script></body></html>`;

const HOME = (missing: readonly string[], captcha: boolean): string =>
  html(
    `<nav>${missing.includes('accountSwitcher') ? '' : '<button data-testid="SideNav_AccountSwitcher_Button">SMP Demo</button>'}</nav>
     <main><h1>Home</h1>${captcha ? '<iframe src="https://client-api.arkoselabs.com/fc/gc/"></iframe>' : ''}</main>`,
    `fetch('/i/api/graphql/v1/Viewer?variables=%7B%7D');`,
  );

const COMPOSE = (missing: readonly string[]): string =>
  html(
    `<div role="dialog" aria-label="Compose">
       <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Post text"></div>
       ${missing.includes('fileInput') ? '' : '<input type="file" data-testid="fileInput" multiple accept="image/*">'}
       <div id="media"></div>
       ${missing.includes('tweetButton') ? '' : '<button data-testid="tweetButton" disabled aria-disabled="true">Post</button>'}
     </div>
     <div id="alt" hidden><textarea data-testid="altTextInput"></textarea><button data-testid="endEditingButton">Save</button></div>`,
    `const box = document.querySelector('[data-testid=tweetTextarea_0]');
     const button = document.querySelector('[data-testid=tweetButton]');
     const files = document.querySelector('[data-testid=fileInput]');
     const altInput = document.querySelector('[data-testid=altTextInput]');
     const media = [];
     let uploading = 0;
     let editing = -1;
     const update = () => {
       if (!button) return;
       const ready = box.innerText.trim() !== '' && uploading === 0;
       button.disabled = !ready;
       button.setAttribute('aria-disabled', String(!ready));
     };
     box.addEventListener('input', update);
     files?.addEventListener('change', () => {
       for (const file of files.files) {
         const index = media.length;
         media.push({ name: file.name, size: file.size, alt: null });
         uploading += 1;
         setTimeout(() => {
           uploading -= 1;
           const label = document.createElement('button');
           label.dataset.testid = 'altTextLabel';
           label.textContent = 'Add description';
           label.onclick = () => { editing = index; document.getElementById('alt').hidden = false; };
           document.getElementById('media').append(label);
           update();
         }, 300);
       }
       update();
     });
     document.querySelector('[data-testid=endEditingButton]').onclick = () => {
       media[editing].alt = altInput.value;
       altInput.value = '';
       document.getElementById('alt').hidden = true;
     };
     button?.addEventListener('click', () => {
       fetch('/i/api/graphql/c1/CreateTweet', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ variables: { tweet_text: box.innerText, media } }),
       });
     });`,
  );

/** The shell of the web app that sends the visitor on after loading. */
const REDIRECT = (path: string): string =>
  html('<main></main>', `setTimeout(() => location.replace(${JSON.stringify(path)}), 50);`);

const STATUS = (postId: string): string =>
  html(
    `<article><p>Post ${postId}</p><button data-testid="caret" aria-label="More">...</button></article>
     <article><p>A reply</p><button data-testid="caret" aria-label="More">...</button></article>
     <div role="menu" id="menu" hidden><div role="menuitem" id="delete"></div></div>
     <div id="confirm" hidden><button data-testid="confirmationSheetConfirm">Delete</button></div>`,
    `const id = ${JSON.stringify(postId)};
     document.getElementById('delete').textContent = navigator.language.startsWith('de') ? 'Löschen' : 'Delete';
     fetch('/i/api/graphql/d1/TweetDetail?variables=' + encodeURIComponent(JSON.stringify({ focalTweetId: id })));
     document.querySelector('[data-testid=caret]').onclick = () => { document.getElementById('menu').hidden = false; };
     document.getElementById('delete').onclick = () => { document.getElementById('confirm').hidden = false; };
     document.querySelector('[data-testid=confirmationSheetConfirm]').onclick = () => {
       fetch('/i/api/graphql/x1/DeleteTweet', { method: 'POST', body: JSON.stringify({ variables: { tweet_id: id } }) });
     };`,
  );

const PROFILE = (handle: string): string =>
  html(
    `<main><h1>@${handle}</h1></main>`,
    `const variables = encodeURIComponent(JSON.stringify({ screen_name: ${JSON.stringify(handle)} }));
     fetch('/i/api/graphql/u1/UserByScreenName?variables=' + variables);
     fetch('/i/api/graphql/t1/UserTweets?variables=' + variables);`,
  );

const LOGIN = html(
  `<main><h1>Sign in to X</h1><div id="step"></div></main>`,
  `const step = document.getElementById('step');
   let current = null;
   const field = (attributes) => {
     step.innerHTML = '<input ' + attributes + '>';
     const input = step.querySelector('input');
     input.addEventListener('keydown', (event) => {
       if (event.key === 'Enter') send({ subtask: current, value: input.value });
     });
   };
   const show = (answer) => {
     if (answer.errors) {
       if (current === 'LoginTwoFactorAuthChallenge') {
         step.querySelector('input').value = '';
       } else {
         step.innerHTML = '<p role="alert">' + answer.errors[0].message + '</p>';
       }
       return;
     }
     current = answer.subtasks[0].subtask_id;
     if (current === 'LoginJsInstrumentationSubtask') send({ subtask: current });
     else if (current === 'LoginEnterUserIdentifierSSO') field('autocomplete="username" name="text"');
     else if (current === 'LoginEnterPassword') field('type="password" name="password" autocomplete="current-password"');
     else if (current === 'LoginTwoFactorAuthChallenge') field('data-testid="ocfEnterTextTextInput" inputmode="numeric"');
     else if (current === 'LoginSuccessSubtask') location.href = '/home';
     else step.innerHTML = '<p>' + current + '</p>';
   };
   const send = (body) =>
     fetch('https://api.x.com/1.1/onboarding/task.json' + (body ? '' : '?flow_name=login'), {
       method: 'POST',
       body: JSON.stringify(body ?? {}),
     }).then((response) => response.json()).then(show);
   send(null);`,
);

const subtask = (id: string) => ({
  flow_token: 'flow-token',
  status: 'success',
  subtasks: [{ subtask_id: id }],
});

export class FakeX {
  readonly sent: SentPost[] = [];
  readonly deleted: string[] = [];
  readonly codes: string[] = [];
  private signedIn: boolean;

  constructor(private readonly options: FakeXOptions = {}) {
    this.signedIn = options.signedIn ?? true;
  }

  async install(page: Page): Promise<void> {
    await page.route('**/*', (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (url.host === 'api.x.com' && url.pathname === '/1.1/onboarding/task.json') {
      return this.loginStep(route);
    }
    if (url.host === 'abs.twimg.com') {
      return route.fulfill({ contentType: 'application/javascript', body: '' });
    }
    if (url.host !== 'x.com') {
      return route.abort('blockedbyclient');
    }
    const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: 'application/json', body, headers });
    const page = (body: string) => route.fulfill({ contentType: 'text/html', body });
    const missing = this.options.missing ?? [];
    const path = url.pathname;

    const operation = /^\/i\/api\/graphql\/[^/]+\/(\w+)$/.exec(path)?.[1];
    switch (operation) {
      case 'Viewer':
        return json(fixture('viewer.json'));
      case 'CreateTweet':
        return this.createPost(route, json);
      case 'TweetDetail': {
        const variables = JSON.parse(url.searchParams.get('variables') ?? '{}') as { focalTweetId?: string };
        const gone = (this.options.deletedPosts ?? []).includes(variables.focalTweetId ?? '');
        return json(fixture(gone ? 'tweet-detail-tombstone.json' : 'tweet-detail.json'));
      }
      case 'DeleteTweet': {
        const body = JSON.parse(request.postData() ?? '{}') as { variables?: { tweet_id?: string } };
        this.deleted.push(body.variables?.tweet_id ?? '');
        return json(fixture('delete-tweet.json'));
      }
      case 'UserByScreenName':
        return json(fixture('user-by-screen-name.json'));
      case 'UserTweets':
        return json(fixture('user-tweets.json'));
      default:
        break;
    }
    if (path === '/i/flow/login') {
      return page(LOGIN);
    }
    if (path === '/account/access') {
      return page(html('<h1>Your account has been locked.</h1>'));
    }
    const signedInPage = path === '/home' || path === '/compose/post' || /\/status\/\d+$/.test(path);
    if (signedInPage && !this.signedIn) {
      // Like the web app, the shell loads and then sends a signed-out visitor to the login.
      return page(REDIRECT('/i/flow/login'));
    }
    if (path === '/home') {
      return page(HOME(missing, this.options.challenge === 'home-captcha'));
    }
    if (path === '/compose/post') {
      return page(
        this.options.challenge === 'compose-redirect' ? REDIRECT('/account/access') : COMPOSE(missing),
      );
    }
    const status = /^\/(?:\w+|i)\/status\/(\d+)$/.exec(path);
    if (status?.[1]) {
      return page(STATUS(status[1]));
    }
    const profile = /^\/(\w{1,15})$/.exec(path);
    if (profile?.[1]) {
      return page(PROFILE(profile[1]));
    }
    return route.fulfill({ status: 404, contentType: 'text/html', body: html('<h1>Not found</h1>') });
  }

  private createPost(
    route: Route,
    json: (body: string, status?: number, headers?: Record<string, string>) => Promise<void>,
  ) {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      variables: { tweet_text: string; media: SentPost['media'] };
    };
    this.sent.push({ text: body.variables.tweet_text, media: body.variables.media });
    switch (this.options.createPost ?? 'ok') {
      case 'duplicate':
        return json(fixture('create-tweet-duplicate.json'));
      case 'rate-limited':
        return json('{"errors":[{"code":88,"message":"Rate limit exceeded."}]}', 429, {
          'x-rate-limit-reset': String(Math.floor(Date.parse('2026-10-17T08:30:00Z') / 1000)),
        });
      case 'silent':
        // X never answers: the post may or may not be out.
        return Promise.resolve();
      default:
        return json(fixture('create-tweet.json'));
    }
  }

  private loginStep(route: Route): Promise<void> {
    const cors = {
      'access-control-allow-origin': 'https://x.com',
      'access-control-allow-credentials': 'true',
    };
    const answer = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body), headers: cors });
    const login = this.options.login;
    const sent = JSON.parse(route.request().postData() ?? '{}') as { subtask?: string; value?: string };
    if (!login) {
      return answer({ errors: [{ code: 366, message: 'flow_name is not supported' }] });
    }
    switch (sent.subtask) {
      case undefined:
        return answer(subtask('LoginJsInstrumentationSubtask'));
      case 'LoginJsInstrumentationSubtask':
        return answer(subtask('LoginEnterUserIdentifierSSO'));
      case 'LoginEnterUserIdentifierSSO':
        return sent.value === login.username
          ? answer(subtask('LoginEnterPassword'))
          : answer({ errors: [{ code: 399, message: 'Sorry, we could not find your account.' }] });
      case 'LoginEnterPassword':
        if (sent.value !== login.password) {
          return answer({ errors: [{ code: 399, message: 'Wrong password!' }] });
        }
        if (login.challenge) {
          return answer(subtask(login.challenge));
        }
        if (login.code) {
          return answer(subtask('LoginTwoFactorAuthChallenge'));
        }
        this.signedIn = true;
        return answer(subtask('LoginSuccessSubtask'));
      case 'LoginTwoFactorAuthChallenge':
        this.codes.push(sent.value ?? '');
        if (sent.value !== login.code) {
          return answer({ errors: [{ code: 236, message: 'The code you entered is incorrect.' }] });
        }
        this.signedIn = true;
        return answer(subtask('LoginSuccessSubtask'));
      default:
        return answer({ errors: [{ code: 0, message: 'unknown step' }] });
    }
  }
}
