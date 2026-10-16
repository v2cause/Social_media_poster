import { brandVoiceContentSchema, type BrandVoiceDto } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import { linesOf, toVoiceContent, toVoiceForm, voiceFormSchema } from './voice-form';

const voice: BrandVoiceDto = {
  id: '01a144a9-a274-7767-993c-73a19b361453',
  name: 'Klar und nahbar',
  isDefault: true,
  archived: false,
  currentVersionNumber: 2,
  version: 3,
  updatedAt: '2026-10-16T10:00:00.000Z',
  content: {
    name: 'Klar und nahbar',
    description: 'Software für Handwerksbetriebe.',
    tone: ['freundlich', 'kompetent'],
    dos: ['Konkrete Beispiele nennen', 'Leser direkt ansprechen'],
    donts: ['Fachjargon'],
    vocabulary: ['Werkstatt'],
    forbiddenWords: ['billig'],
    emojiPolicy: 'sparse',
    hashtagPolicy: 'few',
    examplePosts: ['Erster Beitrag.', 'Zweiter Beitrag.'],
    language: 'de',
  },
};

describe('linesOf', () => {
  it('keeps the trimmed, non-empty lines', () => {
    expect(linesOf('  eins \n\n zwei\n   \n')).toEqual(['eins', 'zwei']);
  });
});

describe('voice form', () => {
  it('turns a voice into the form and back into the same content', () => {
    const values = voiceFormSchema.parse(toVoiceForm(voice, 'en'));

    expect(brandVoiceContentSchema.parse(toVoiceContent(values))).toEqual(voice.content);
    expect(values.isDefault).toBe(true);
  });

  it('starts a new voice in the workspace language with three empty examples', () => {
    const form = toVoiceForm(null, 'en');

    expect(form.language).toBe('en');
    expect(form.examplePosts).toHaveLength(3);
    expect(toVoiceContent(voiceFormSchema.parse({ ...form, name: 'Neu' })).examplePosts).toEqual([]);
  });

  it('reports too many or too long rules with their own messages', () => {
    const form = toVoiceForm(voice, 'de');
    const tooMany = voiceFormSchema.safeParse({
      ...form,
      dos: Array.from({ length: 21 }, (_, i) => `Punkt ${String(i)}`).join('\n'),
    });
    const tooLong = voiceFormSchema.safeParse({ ...form, donts: 'x'.repeat(201) });

    expect(tooMany.error?.issues[0]?.message).toBe('too_many_items');
    expect(tooLong.error?.issues[0]?.message).toBe('item_too_long');
  });
});
