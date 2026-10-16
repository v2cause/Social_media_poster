import { describe, expect, it } from 'vitest';

import { outputJsonSchemas, variantsOutputSchema } from './schemas';

const variant = {
  targetKey: 't1',
  platform: 'LINKEDIN',
  hook: 'Der neue Kalender ist da.',
  text: 'Der neue Kalender ist da.\n\nTeams sparen Zeit.',
  hashtags: ['kalender'],
  firstComment: null,
  callToAction: null,
  altTexts: [],
  warnings: [],
};

/** Every object schema in a JSON schema, recursively. */
function objectSchemas(schema: unknown): Record<string, unknown>[] {
  if (Array.isArray(schema)) {
    return schema.flatMap(objectSchemas);
  }
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }
  const record = schema as Record<string, unknown>;
  const own = record['type'] === 'object' ? [record] : [];
  return [...own, ...Object.values(record).flatMap(objectSchemas)];
}

describe('output schemas', () => {
  it('export as JSON Schema with additionalProperties false on every object', () => {
    const schemas = outputJsonSchemas();
    for (const schema of Object.values(schemas)) {
      const objects = objectSchemas(schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) {
        expect(object['additionalProperties']).toBe(false);
      }
    }
  });

  it('use no constraints the structured output API does not support', () => {
    const json = JSON.stringify(outputJsonSchemas());
    expect(json).not.toMatch(/"(minLength|maxLength|minimum|maximum|multipleOf)"/);
  });

  it('accept a complete variant and reject unknown fields and platforms', () => {
    expect(variantsOutputSchema.safeParse({ variants: [variant] }).success).toBe(true);
    expect(variantsOutputSchema.safeParse({ variants: [{ ...variant, extra: 1 }] }).success).toBe(false);
    expect(variantsOutputSchema.safeParse({ variants: [{ ...variant, platform: 'TIKTOK' }] }).success).toBe(
      false,
    );
  });
});
