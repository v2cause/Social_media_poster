import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOpenApiDocument, OPENAPI_DTOS } from '../src/openapi';
import { startApiTestApp, type ApiTestApp } from './support/api-app';

// The committed OpenAPI document of packages/api-client must match the API. After a change to a
// route or DTO: UPDATE_OPENAPI=1 pnpm --filter @smp/api test:integration, then
// pnpm --filter @smp/api-client generate.

const DOCUMENT = resolve(__dirname, '../../../packages/api-client/openapi.json');

describe('OpenAPI document', () => {
  let api: ApiTestApp | undefined;

  beforeAll(async () => {
    api = await startApiTestApp();
  });

  afterAll(async () => {
    await api?.close();
  });

  it('matches packages/api-client/openapi.json', async () => {
    if (!api) {
      throw new Error('API is not running');
    }
    const current = `${JSON.stringify(createOpenApiDocument(api.app), null, 2)}\n`;
    if (process.env['UPDATE_OPENAPI'] === '1') {
      await writeFile(DOCUMENT, current);
    }
    const committed = await readFile(DOCUMENT, 'utf8').catch(() => '');
    expect(committed, 'Run UPDATE_OPENAPI=1 pnpm --filter @smp/api test:integration').toBe(current);
  });

  it('generates every component schema from a registered zod schema', () => {
    if (!api) {
      throw new Error('API is not running');
    }
    const registered = new Set(OPENAPI_DTOS.map((dto) => dto.name));
    const names = Object.keys(createOpenApiDocument(api.app).components?.schemas ?? {});
    expect(names.filter((name) => !registered.has(name.replace(/_Output$/, '')))).toEqual([]);
  });
});
