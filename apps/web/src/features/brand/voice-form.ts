import {
  EMOJI_POLICIES,
  HASHTAG_POLICIES,
  localeSchema,
  type BrandVoiceContentInput,
  type BrandVoiceDto,
  type Locale,
} from '@smp/contracts';
import { z } from 'zod';

// The form of the brand voice editor (guide step 2.9). Do and don't lists are edited as text
// with one point per line, the examples as a list of text fields; the limits are those of
// brandVoiceContentSchema, which the API checks again.

export const VOICE_LIMITS = {
  name: 80,
  description: 1000,
  tone: { items: 10, length: 40 },
  rules: { items: 20, length: 200 },
  vocabulary: { items: 50, length: 60 },
  forbiddenWords: { items: 100, length: 60 },
  examples: { items: 5, length: 3000 },
} as const;

/** The non-empty lines of a text, trimmed. */
export const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const lines = (limits: { items: number; length: number }) =>
  z.string().superRefine((text, context) => {
    const items = linesOf(text);
    if (items.length > limits.items) {
      context.addIssue({ code: 'custom', message: 'too_many_items' });
    } else if (items.some((item) => item.length > limits.length)) {
      context.addIssue({ code: 'custom', message: 'item_too_long' });
    }
  });

const terms = (limits: { items: number; length: number }) =>
  z.array(z.string().trim().min(1).max(limits.length)).max(limits.items);

export const voiceFormSchema = z.object({
  name: z.string().trim().min(1).max(VOICE_LIMITS.name),
  description: z.string().trim().max(VOICE_LIMITS.description),
  language: localeSchema,
  isDefault: z.boolean(),
  tone: terms(VOICE_LIMITS.tone),
  dos: lines(VOICE_LIMITS.rules),
  donts: lines(VOICE_LIMITS.rules),
  vocabulary: terms(VOICE_LIMITS.vocabulary),
  forbiddenWords: terms(VOICE_LIMITS.forbiddenWords),
  emojiPolicy: z.enum(EMOJI_POLICIES),
  hashtagPolicy: z.enum(HASHTAG_POLICIES),
  examplePosts: z
    .array(z.object({ text: z.string().trim().max(VOICE_LIMITS.examples.length) }))
    .max(VOICE_LIMITS.examples.items),
});
export type VoiceForm = z.input<typeof voiceFormSchema>;
export type VoiceFormValues = z.output<typeof voiceFormSchema>;

/** Three empty examples invite the recommended three to five. */
const EMPTY_EXAMPLES = 3;

export function toVoiceForm(voice: BrandVoiceDto | null, language: Locale): VoiceForm {
  if (!voice) {
    return {
      name: '',
      description: '',
      language,
      isDefault: false,
      tone: [],
      dos: '',
      donts: '',
      vocabulary: [],
      forbiddenWords: [],
      emojiPolicy: 'sparse',
      hashtagPolicy: 'few',
      examplePosts: Array.from({ length: EMPTY_EXAMPLES }, () => ({ text: '' })),
    };
  }
  const { content } = voice;
  return {
    name: content.name,
    description: content.description,
    language: content.language,
    isDefault: voice.isDefault,
    tone: content.tone,
    dos: content.dos.join('\n'),
    donts: content.donts.join('\n'),
    vocabulary: content.vocabulary,
    forbiddenWords: content.forbiddenWords,
    emojiPolicy: content.emojiPolicy,
    hashtagPolicy: content.hashtagPolicy,
    examplePosts: content.examplePosts.map((text) => ({ text })),
  };
}

/** The content of a new version; empty examples are left out. */
export function toVoiceContent(values: VoiceFormValues): BrandVoiceContentInput {
  return {
    name: values.name,
    description: values.description,
    language: values.language,
    tone: values.tone,
    dos: linesOf(values.dos),
    donts: linesOf(values.donts),
    vocabulary: values.vocabulary,
    forbiddenWords: values.forbiddenWords,
    emojiPolicy: values.emojiPolicy,
    hashtagPolicy: values.hashtagPolicy,
    examplePosts: values.examplePosts.map((example) => example.text).filter((text) => text.length > 0),
  };
}
