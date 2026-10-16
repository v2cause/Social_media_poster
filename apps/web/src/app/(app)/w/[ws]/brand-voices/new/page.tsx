import { toLocale } from '@smp/contracts';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { VoiceEditorPage } from '@/features/brand/voice-editor';
import { getWorkspaceContext } from '@/lib/server/api';

export async function generateMetadata() {
  const t = await getTranslations('brand.editor');
  return { title: t('newTitle') };
}

/** A new brand voice; only owners and admins create them. */
export default async function NewBrandVoiceRoute({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const context = await getWorkspaceContext(ws);
  if (!context.permissions.includes('brand_voice.manage')) {
    notFound();
  }
  return (
    <VoiceEditorPage
      ws={ws}
      voice={null}
      contentLanguage={toLocale(context.workspace.contentLanguage)}
      canManage
    />
  );
}
