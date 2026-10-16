import type { Server } from 'node:http';

import request from 'supertest';

import type { ApiTestApp } from './api-app';
import { APP_ORIGIN } from './api-app';

export const PASSWORD = 'correct horse battery staple';

export type Browser = ReturnType<typeof request.agent>;

let nextAddress = 10;

/**
 * A cookie-keeping client that behaves like the browser on the app origin. Each one gets its own
 * client address (X-Real-IP, set by the reverse proxy in production), so that the rate limits of
 * one test do not spill into the next.
 */
export function browser(server: Server, address = `192.0.2.${String((nextAddress += 1))}`): Browser {
  return request.agent(server).set('Origin', APP_ORIGIN).set('X-Real-IP', address);
}

/** Signs up, opens the verification link from Mailpit and returns the signed-in browser. */
export async function signUpVerified(api: ApiTestApp, email: string, name = 'Test User'): Promise<Browser> {
  const agent = browser(api.server);
  await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: PASSWORD, name, callbackURL: '/onboarding' })
    .expect(200);
  const message = await api.mailpit.waitForMessage(email);
  const link = /https?:\/\/\S+verify-email\S+/.exec(message.Text)?.[0];
  if (!link) {
    throw new Error(`no verification link for ${email}`);
  }
  const url = new URL(link);
  await agent.get(`${url.pathname}${url.search}`).expect(302);
  return agent;
}

/** Signs in an existing user with the shared test password. */
export async function signIn(api: ApiTestApp, email: string, password = PASSWORD): Promise<Browser> {
  const agent = browser(api.server);
  await agent.post('/api/auth/sign-in/email').send({ email, password }).expect(200);
  return agent;
}
