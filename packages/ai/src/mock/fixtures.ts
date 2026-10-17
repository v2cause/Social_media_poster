import type { ContentLanguage } from '@smp/core';
import { PLATFORMS } from '@smp/platform-rules';
import { z } from 'zod';

import { STYLE_PRESETS } from '../prompts/style-presets';
import de from './fixtures/de.json';
import en from './fixtures/en.json';

// The texts of the MockAiProvider per language (guide step 2.5). Validated once at load, so a
// broken fixture fails every test of the package instead of producing odd posts.

const TOPIC = '{topic}';

const styleSchema = z.strictObject({
  /** One sentence with the placeholder {topic}. */
  hook: z.string().includes(TOPIC),
  paragraphs: z.array(z.string().min(1)).length(2),
  callToAction: z.string().min(1),
  hashtags: z.array(z.string().regex(/^[\p{L}\p{N}]+$/u)).length(5),
});

const ideaSchema = z.strictObject({
  title: z.string().min(1),
  angle: z.string().min(1),
  whyNow: z.string().min(1),
  format: z.string().min(1),
  styleKey: z.string().min(1),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
});

const fixtureSchema = z
  .strictObject({
    fallbackTopic: z.string().min(1),
    styles: z.record(z.string(), styleSchema),
    /** For custom styles, whose instructions the mock cannot follow. */
    customStyle: styleSchema,
    refine: z.strictObject({
      leads: z.strictObject({
        more_formal: z.string().min(1),
        more_casual: z.string().min(1),
        stronger_hook: z.string().min(1),
      }),
      longer: z.array(z.string().min(1)).min(1),
      addCallToAction: z.string().min(1),
      custom: z.string().includes('{instruction}'),
    }),
    firstCommentLabel: z.string().min(1),
    numberWarning: z.string().min(1),
    altText: z.strictObject({
      withContext: z.string().includes('{context}'),
      withoutContext: z.string().min(1),
    }),
    ideas: z.strictObject({
      labels: z.strictObject({ pillar: z.string().min(1), profile: z.string().min(1) }),
      date: ideaSchema,
      /** A follow-up of a top post (guide step 5.6). */
      topPost: ideaSchema.extend({
        title: z.string().includes(TOPIC),
        whyNow: z.string().includes('{date}'),
      }),
      items: z.array(ideaSchema).length(10),
    }),
  })
  .superRefine((fixture, ctx) => {
    for (const preset of STYLE_PRESETS) {
      if (!(preset.key in fixture.styles)) {
        ctx.addIssue({ code: 'custom', path: ['styles', preset.key], message: 'missing preset' });
      }
    }
  });

export type MockFixture = z.infer<typeof fixtureSchema>;
export type MockStyle = z.infer<typeof styleSchema>;

const FIXTURES: Readonly<Record<ContentLanguage, MockFixture>> = {
  de: fixtureSchema.parse(de),
  en: fixtureSchema.parse(en),
};

export const fixtureOf = (language: ContentLanguage): MockFixture => FIXTURES[language];

export const allFixtures = (): readonly MockFixture[] => Object.values(FIXTURES);

/** The texts of a style; custom styles share one set. */
export const styleOf = (language: ContentLanguage, styleKey: string): MockStyle => {
  const fixture = fixtureOf(language);
  return fixture.styles[styleKey] ?? fixture.customStyle;
};

/** Fills {name} placeholders; a function replacement, so "$" in user text stays literal. */
export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
