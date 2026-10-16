import { describe, expect, it } from 'vitest';

import {
  CreateBrandVoice,
  CreateStyle,
  customStyleKey,
  NotPermittedError,
  PresetStyleError,
  StyleNameTakenError,
  UpdateBrandVoice,
  UpdateIdea,
  UpdateStyle,
  VersionConflictError,
  type BrandVoiceContent,
} from '../../src';
import { actorOf, createContentTestbed, PRESET_STYLE } from '../in-memory-content';

const admin = actorOf('ADMIN');

const content = (overrides: Partial<BrandVoiceContent> = {}): BrandVoiceContent => ({
  name: 'Acme',
  description: 'Klar und freundlich.',
  tone: ['klar'],
  dos: [],
  donts: [],
  vocabulary: [],
  forbiddenWords: ['Synergie'],
  emojiPolicy: 'none',
  hashtagPolicy: 'few',
  examplePosts: [],
  language: 'de',
  ...overrides,
});

describe('customStyleKey', () => {
  it('derives a stable key from the name', () => {
    expect(customStyleKey('Kurz & herzlich')).toBe('custom-kurz-herzlich');
    expect(customStyleKey('Grüße aus Köln')).toBe('custom-grusse-aus-koln');
    expect(customStyleKey('!!!')).toBe('custom-style');
  });
});

describe('styles', () => {
  it('creates custom styles in order and refuses a second style with the same key', async () => {
    const testbed = createContentTestbed();
    const create = new CreateStyle(testbed);

    const first = await create.execute({ actor: admin, name: 'Kurz & herzlich', instructions: 'Kurz.' });
    const second = await create.execute({ actor: admin, name: 'Sachlich', instructions: 'Nüchtern.' });
    await expect(
      create.execute({ actor: admin, name: 'kurz herzlich', instructions: 'x' }),
    ).rejects.toBeInstanceOf(StyleNameTakenError);

    const styles = testbed.unitOfWork.state.styles;
    expect(styles.get(first.styleId)).toMatchObject({
      key: 'custom-kurz-herzlich',
      sortOrder: 0,
      isActive: true,
    });
    expect(styles.get(second.styleId)).toMatchObject({ key: 'custom-sachlich', sortOrder: 1 });
    expect(testbed.unitOfWork.state.audit.map((entry) => entry.action)).toEqual([
      'style.create',
      'style.create',
    ]);
  });

  it('renames with a new key, deactivates and never changes a preset', async () => {
    const testbed = createContentTestbed();
    const { styleId } = await new CreateStyle(testbed).execute({
      actor: admin,
      name: 'Alt',
      instructions: 'x',
    });
    const update = new UpdateStyle(testbed);

    await update.execute({ actor: admin, styleId, version: 0, patch: { name: 'Neu', isActive: false } });

    expect(testbed.unitOfWork.state.styles.get(styleId)).toMatchObject({
      name: 'Neu',
      key: 'custom-neu',
      isActive: false,
      version: 1,
    });
    await expect(
      update.execute({ actor: admin, styleId: PRESET_STYLE.id, version: 0, patch: { name: 'x' } }),
    ).rejects.toBeInstanceOf(PresetStyleError);
    await expect(
      update.execute({ actor: actorOf('EDITOR'), styleId, version: 1, patch: { isActive: true } }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});

describe('brand voices', () => {
  it('makes the first voice the default and keeps a single default', async () => {
    const testbed = createContentTestbed();
    const create = new CreateBrandVoice(testbed);

    const first = await create.execute({ actor: admin, content: content(), isDefault: false });
    const second = await create.execute({
      actor: admin,
      content: content({ name: 'Zweite' }),
      isDefault: true,
    });

    const voices = testbed.unitOfWork.state.voices;
    expect(voices.get(first.brandVoiceId)?.isDefault).toBe(false);
    expect(voices.get(second.brandVoiceId)).toMatchObject({
      name: 'Zweite',
      isDefault: true,
      currentVersionNumber: 1,
    });
    expect(testbed.unitOfWork.state.versions).toHaveLength(2);
  });

  it('adds a version only when the content changes', async () => {
    const testbed = createContentTestbed();
    const { brandVoiceId } = await new CreateBrandVoice(testbed).execute({
      actor: admin,
      content: content(),
      isDefault: false,
    });
    const update = new UpdateBrandVoice(testbed);

    await update.execute({ actor: admin, brandVoiceId, version: 0, content: content() });
    await update.execute({
      actor: admin,
      brandVoiceId,
      version: 1,
      content: content({ name: 'Acme Neu', tone: ['warm'] }),
    });
    await expect(
      update.execute({ actor: admin, brandVoiceId, version: 1, isDefault: false }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    expect(testbed.unitOfWork.state.voices.get(brandVoiceId)).toMatchObject({
      name: 'Acme Neu',
      currentVersionNumber: 2,
      version: 2,
    });
    expect(testbed.unitOfWork.state.versions.map((version) => version.versionNumber)).toEqual([1, 2]);
  });

  it('archives a voice and takes away its default flag', async () => {
    const testbed = createContentTestbed();
    const { brandVoiceId } = await new CreateBrandVoice(testbed).execute({
      actor: admin,
      content: content(),
      isDefault: true,
    });

    await new UpdateBrandVoice(testbed).execute({ actor: admin, brandVoiceId, version: 0, archived: true });

    expect(testbed.unitOfWork.state.voices.get(brandVoiceId)).toMatchObject({
      isDefault: false,
      archivedAt: new Date('2026-10-16T12:00:00Z'),
    });
  });

  it('is managed by owners and admins only', async () => {
    const testbed = createContentTestbed();

    await expect(
      new CreateBrandVoice(testbed).execute({
        actor: actorOf('EDITOR'),
        content: content(),
        isDefault: false,
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});

describe('UpdateIdea', () => {
  it('discards an idea with the current version', async () => {
    const testbed = createContentTestbed();
    testbed.unitOfWork.state.ideas.set('idea-1', {
      id: 'idea-1',
      workspaceId: 'ws-1',
      title: 'Ein Blick hinter die Kulissen',
      angle: null,
      pillar: null,
      whyNow: null,
      basedOn: [],
      suggestedPlatforms: ['INSTAGRAM'],
      suggestedStyleKey: 'storytelling',
      format: null,
      status: 'NEW',
      source: 'AI',
      aiGenerationId: null,
      createdById: null,
      version: 0,
    });

    await new UpdateIdea(testbed).execute({
      actor: actorOf('EDITOR'),
      ideaId: 'idea-1',
      version: 0,
      patch: { status: 'DISCARDED' },
    });

    expect(testbed.unitOfWork.state.ideas.get('idea-1')).toMatchObject({ status: 'DISCARDED', version: 1 });
  });
});
