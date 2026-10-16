import { toLocale } from '@smp/contracts';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { VoiceEditorPage } from '@/features/brand/voice-editor';
import { getBrandVoice, getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('brand');
  return { title: t('title') };
}

/** A brand voice with its test and version history; read-only without brand_voice.manage. */
export default async function BrandVoiceRoute({
  params,
}: {
  params: Promise<{ ws: string; voiceId: string }>;
}) {
  const { ws, voiceId } = await params;
  if (!z.uuid().safeParse(voiceId).success) {
    notFound();
  }
  const [context, voice] = await Promise.all([getWorkspaceContext(ws), getBrandVoice(ws, voiceId)]);
  return (
    <VoiceEditorPage
      key={voice.id}
      ws={ws}
      voice={voice}
      contentLanguage={toLocale(context.workspace.contentLanguage)}
      canManage={context.permissions.includes('brand_voice.manage')}
    />
  );
}
