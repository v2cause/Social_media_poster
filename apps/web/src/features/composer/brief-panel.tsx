'use client';

import { BRIEF_MAX_LENGTH, LOCALES, type BrandVoiceDto, type Locale, type StyleDto } from '@smp/contracts';
import { PLATFORMS, type Platform } from '@smp/platform-rules';
import { Button, Card, CardContent, CardHeader, CardTitle, Label, NativeSelect, Textarea, cn } from '@smp/ui';
import { Sparkles, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { DraftPost } from './composer-model';
import { StyleSelect } from './style-select';

// The left column of the composer (guide step 2.8): brief with counter, style, brand voice,
// target platforms as chips, language and the generate button.

export function BriefPanel(props: {
  post: DraftPost;
  styles: readonly StyleDto[];
  voices: readonly BrandVoiceDto[];
  readOnly: boolean;
  /** The role may use the AI (ai.use). */
  canGenerate: boolean;
  /** Texts exist already: the button generates them again. */
  regenerate: boolean;
  generating: boolean;
  onChange: (patch: Partial<DraftPost>) => void;
  onGenerate: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const { post } = props;
  const length = post.brief.length;
  const togglePlatform = (platform: Platform) => {
    const platforms = post.platforms.includes(platform)
      ? post.platforms.filter((candidate) => candidate !== platform)
      : PLATFORMS.filter((candidate) => candidate === platform || post.platforms.includes(candidate));
    props.onChange({ platforms });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('composer.brief.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="composer-brief">{t('composer.brief.label')}</Label>
          <Textarea
            id="composer-brief"
            value={post.brief}
            maxLength={BRIEF_MAX_LENGTH}
            rows={7}
            placeholder={t('composer.brief.placeholder')}
            disabled={props.readOnly}
            aria-describedby="composer-brief-counter"
            onChange={(event) => {
              props.onChange({ brief: event.target.value });
            }}
          />
          <p id="composer-brief-counter" className="self-end text-xs text-muted-foreground">
            {t('composer.brief.counter', { count: length, max: BRIEF_MAX_LENGTH })}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="composer-style">{t('composer.brief.style')}</Label>
          <StyleSelect
            id="composer-style"
            styles={props.styles}
            value={post.styleId}
            disabled={props.readOnly}
            onChange={(styleId) => {
              props.onChange({ styleId });
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="composer-voice">{t('composer.brief.voice')}</Label>
          <NativeSelect
            id="composer-voice"
            value={post.brandVoiceId ?? ''}
            disabled={props.readOnly}
            onChange={(event) => {
              props.onChange({ brandVoiceId: event.target.value === '' ? null : event.target.value });
            }}
          >
            <option value="">{t('composer.brief.noVoice')}</option>
            {props.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium leading-none">{t('composer.brief.platforms')}</legend>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((platform) => {
              const selected = post.platforms.includes(platform);
              return (
                <button
                  key={platform}
                  type="button"
                  aria-pressed={selected}
                  disabled={props.readOnly}
                  onClick={() => {
                    togglePlatform(platform);
                  }}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background hover:bg-muted',
                  )}
                >
                  {t(`platforms.${platform}`)}
                </button>
              );
            })}
          </div>
          {post.platforms.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('composer.brief.platformsHint')}</p>
          ) : null}
        </fieldset>

        <div className="flex flex-col gap-2">
          <Label htmlFor="composer-language">{t('composer.brief.language')}</Label>
          <NativeSelect
            id="composer-language"
            value={post.language}
            disabled={props.readOnly}
            onChange={(event) => {
              props.onChange({ language: event.target.value as Locale });
            }}
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(`languages.${locale}`)}
              </option>
            ))}
          </NativeSelect>
        </div>

        {props.readOnly || !props.canGenerate ? null : props.generating ? (
          <Button type="button" variant="outline" onClick={props.onCancel}>
            <Square aria-hidden="true" />
            {t('composer.brief.cancel')}
          </Button>
        ) : (
          <Button type="button" onClick={props.onGenerate} disabled={post.platforms.length === 0}>
            <Sparkles aria-hidden="true" />
            {props.regenerate ? t('composer.brief.regenerate') : t('composer.brief.generate')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
