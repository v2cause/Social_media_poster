'use client';

import { useBrandVoicesList } from '@smp/api-client';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
} from '@smp/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { StylesSection } from './styles-section';

// The brand of a workspace (guide step 2.9): its brand voices, each with versions and a test, and
// the custom styles next to the presets. Owners and admins edit them; everyone else reads.

export function BrandPage(props: { ws: string; canManage: boolean }) {
  const t = useTranslations('brand');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="max-w-2xl text-muted-foreground">{t('description')}</p>
      </div>
      <VoicesSection {...props} />
      <StylesSection {...props} />
    </div>
  );
}

function VoicesSection(props: { ws: string; canManage: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const [showArchived, setShowArchived] = useState(false);
  const voices = useBrandVoicesList(props.ws, showArchived ? { archived: 'true' } : undefined);
  const list = voices.data?.brandVoices ?? [];

  let content;
  if (voices.isPending) {
    content = <LoadingState label={t('states.loading')} />;
  } else if (voices.isError) {
    content = <ErrorState title={t('states.error')} />;
  } else if (list.length === 0) {
    content = <EmptyState title={t('brand.voices.empty')} description={t('brand.voices.emptyHint')} />;
  } else {
    content = (
      <ul className="flex flex-col gap-2">
        {list.map((voice) => (
          <li
            key={voice.id}
            className="flex flex-col gap-1 rounded-md border border-border bg-background p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/w/${props.ws}/brand-voices/${voice.id}`}
                className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {voice.name}
              </Link>
              {voice.isDefault ? <Badge>{t('brand.voices.default')}</Badge> : null}
              {voice.archived ? <Badge variant="muted">{t('brand.voices.archived')}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('brand.voices.meta', {
                language: t(`languages.${voice.content.language}`),
                version: voice.currentVersionNumber,
                date: format.dateTime(new Date(voice.updatedAt), { dateStyle: 'medium' }),
              })}
            </p>
            {voice.content.description ? (
              <p className="line-clamp-2 text-sm">{voice.content.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-lg">{t('brand.voices.title')}</CardTitle>
          <CardDescription>{t('brand.voices.emptyHint')}</CardDescription>
        </div>
        {props.canManage ? (
          <Button asChild>
            <Link href={`/w/${props.ws}/brand-voices/new`}>
              <Plus aria-hidden="true" />
              {t('brand.voices.new')}
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="voices-archived"
            checked={showArchived}
            onChange={(event) => {
              setShowArchived(event.target.checked);
            }}
          />
          <Label htmlFor="voices-archived">{t('brand.voices.showArchived')}</Label>
        </div>
        {content}
      </CardContent>
    </Card>
  );
}
