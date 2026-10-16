import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OPENAPI_DTOS } from './openapi';

describe('OpenAPI DTO registry', () => {
  it('has unique names', () => {
    const names = OPENAPI_DTOS.map((dto) => dto.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes nullable fields as nullable, not as arrays', () => {
    const json = z.toJSONSchema(z.object({ slug: z.string().nullable() }), { target: 'openapi-3.0' });
    expect(json.properties?.['slug']).toEqual({ type: 'string', nullable: true });
  });
});
