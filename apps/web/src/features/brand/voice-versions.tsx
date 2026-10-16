'use client';

import { useBrandVoicesVersions } from '@smp/api-client';
import type { BrandVoiceDto } from '@smp/contracts';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  LoadingState,
} from '@smp/ui';
import { useFormatter, useTranslations } from 'next-intl';

// The versions of a brand voice, newest first (guide step 2.9). Every change of the content
// created one; posts generated with the voice name the version they used.

export function VoiceVersions(props: { ws: string; voice: BrandVoiceDto }) {
  const t = useTranslations();
  const format = useFormatter();
  const versions = useBrandVoicesVersions(props.ws, props.voice.id);
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(', ') : t('brand.versions.none'));

  let content;
  if (versions.isPending) {
    content = <LoadingState label={t('states.loading')} rows={2} />;
  } else if (versions.isError) {
    content = <ErrorState title={t('states.error')} />;
  } else {
    content = (
      <ol className="flex flex-col gap-2">
        {versions.data.versions.map((version) => (
          <li key={version.versionNumber}>
            <details className="rounded-md border border-border bg-background p-3 text-sm">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-medium">
                {t('brand.versions.item', { number: version.versionNumber })}
                <span className="font-normal text-muted-foreground">
                  {format.dateTime(new Date(version.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                {version.versionNumber === props.voice.currentVersionNumber ? (
                  <Badge>{t('brand.versions.current')}</Badge>
                ) : null}
              </summary>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t('brand.editor.name')}</dt>
                <dd>{version.content.name}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.tone')}</dt>
                <dd>{list(version.content.tone)}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.dos')}</dt>
                <dd>{list(version.content.dos)}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.donts')}</dt>
                <dd>{list(version.content.donts)}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.forbiddenWords')}</dt>
                <dd>{list(version.content.forbiddenWords)}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.emojiPolicy')}</dt>
                <dd>{t(`brand.editor.emojiPolicies.${version.content.emojiPolicy}`)}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.hashtagPolicy')}</dt>
                <dd>{t(`brand.editor.hashtagPolicies.${version.content.hashtagPolicy}`)}</dd>
                <dt className="text-muted-foreground">{t('brand.editor.examples')}</dt>
                <dd>{t('brand.versions.examples', { count: version.content.examplePosts.length })}</dd>
              </dl>
            </details>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('brand.versions.title')}</CardTitle>
        <CardDescription>{t('brand.versions.description')}</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
