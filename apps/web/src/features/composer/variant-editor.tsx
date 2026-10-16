'use client';

import { hashtagSchema, VARIANT_TEXT_MAX_LENGTH } from '@smp/contracts';
import {
  capabilitiesOf,
  composePostText,
  countText,
  findForbiddenWords,
  validatePost,
  type ValidationIssue,
} from '@smp/platform-rules';
import { Badge, Input, Label, Textarea, cn } from '@smp/ui';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type KeyboardEvent } from 'react';

import type { DraftVariant } from './composer-model';
import { mediaItemsFor } from './media-items';

// The middle column of the composer (guide step 2.8): one tab per target, the text with a live
// counter that turns red over the limit, hashtag chips, the first comment where the platform has
// one, and the warnings of the AI, the platform rules and the brand voice. Counting and
// validation come from @smp/platform-rules, exactly as on the server.

export function VariantTabs(props: {
  variants: readonly DraftVariant[];
  activeId: string | null;
  onSelect: (variantId: string) => void;
}) {
  const t = useTranslations();
  return (
    <div
      role="tablist"
      aria-label={t('composer.variants.tabs')}
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {props.variants.map((variant) => {
        const selected = variant.id === props.activeId;
        const over = countText(variant.platform, composePostText(variant.text, variant.hashtags)).overLimit;
        return (
          <button
            key={variant.id}
            type="button"
            role="tab"
            id={`variant-tab-${variant.id}`}
            aria-selected={selected}
            aria-controls={`variant-panel-${variant.id}`}
            onClick={() => {
              props.onSelect(variant.id);
            }}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`platforms.${variant.platform}`)}
            {over ? <span className="size-2 rounded-full bg-destructive" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function useIssueMessage(): (issue: ValidationIssue) => string {
  const t = useTranslations('errors.validation');
  return (issue) => t(issue.code, { limit: issue.limit ?? 0, actual: issue.actual ?? 0 });
}

export function VariantEditor(props: {
  variant: DraftVariant;
  /** The text while the AI streams it, for a variant the user does not edit. */
  streamingText: string | null;
  forbiddenWords: readonly string[];
  readOnly: boolean;
  onChange: (patch: Partial<Pick<DraftVariant, 'text' | 'hashtags' | 'firstComment' | 'aiWarnings'>>) => void;
}) {
  const t = useTranslations();
  const issueMessage = useIssueMessage();
  const { variant } = props;
  const text = props.streamingText ?? variant.text;
  const capabilities = capabilitiesOf(variant.platform);
  const count = countText(variant.platform, composePostText(text, variant.hashtags));
  const issues = validatePost({
    platform: variant.platform,
    text,
    hashtags: variant.hashtags,
    firstComment: variant.firstComment,
    media: mediaItemsFor(variant.media, variant.platform),
  });
  const forbidden = findForbiddenWords(
    [text, variant.hashtags.join(' '), variant.firstComment ?? ''],
    props.forbiddenWords,
  );
  const platformName = t(`platforms.${variant.platform}`);
  const counterId = `variant-counter-${variant.id}`;

  return (
    <div
      role="tabpanel"
      id={`variant-panel-${variant.id}`}
      aria-labelledby={`variant-tab-${variant.id}`}
      className="flex flex-col gap-4 pt-4"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`variant-text-${variant.id}`}>{t('composer.variants.text')}</Label>
          <span
            id={counterId}
            className={cn(
              'text-xs tabular-nums',
              count.overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
          >
            {t('composer.variants.counter', { length: count.length, max: count.max })}
          </span>
        </div>
        <Textarea
          id={`variant-text-${variant.id}`}
          value={text}
          rows={12}
          maxLength={VARIANT_TEXT_MAX_LENGTH}
          disabled={props.readOnly}
          aria-invalid={count.overLimit}
          aria-describedby={counterId}
          aria-busy={props.streamingText !== null}
          onChange={(event) => {
            props.onChange({ text: event.target.value });
          }}
        />
        {count.overLimit ? (
          <p className="text-sm text-destructive">
            {t('composer.variants.overLimit', { platform: platformName })}
          </p>
        ) : count.recommendedLength !== undefined && count.length > count.recommendedLength ? (
          <p className="text-xs text-muted-foreground">
            {t('composer.variants.folded', { platform: platformName, length: count.recommendedLength })}
          </p>
        ) : null}
      </div>

      <HashtagChips
        variantId={variant.id}
        hashtags={variant.hashtags}
        readOnly={props.readOnly}
        onChange={(hashtags) => {
          props.onChange({ hashtags });
        }}
      />

      {capabilities.firstComment ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`variant-comment-${variant.id}`}>{t('composer.variants.firstComment')}</Label>
          <Textarea
            id={`variant-comment-${variant.id}`}
            rows={2}
            value={variant.firstComment ?? ''}
            disabled={props.readOnly}
            onChange={(event) => {
              props.onChange({ firstComment: event.target.value === '' ? null : event.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">{t('composer.variants.firstCommentHint')}</p>
        </div>
      ) : null}

      <Warnings
        aiWarnings={variant.aiWarnings}
        issues={issues.filter((issue) => issue.code !== 'TEXT_TOO_LONG').map(issueMessage)}
        forbidden={forbidden}
        autoShortened={variant.check?.autoShortened ?? false}
      />
    </div>
  );
}

function HashtagChips(props: {
  variantId: string;
  hashtags: readonly string[];
  readOnly: boolean;
  onChange: (hashtags: string[]) => void;
}) {
  const t = useTranslations('composer.variants');
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputId = `variant-hashtag-${props.variantId}`;

  const add = () => {
    const parsed = hashtagSchema.safeParse(draft);
    if (!parsed.success) {
      setInvalid(draft.trim().length > 0);
      return;
    }
    if (!props.hashtags.some((tag) => tag.toLowerCase() === parsed.data.toLowerCase())) {
      props.onChange([...props.hashtags, parsed.data]);
    }
    setDraft('');
    setInvalid(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{t('hashtags')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        {props.hashtags.map((tag) => (
          <Badge key={tag} className="gap-1">
            #{tag}
            {props.readOnly ? null : (
              <button
                type="button"
                className="rounded-full hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('removeHashtag', { tag: `#${tag}` })}
                onClick={() => {
                  props.onChange(props.hashtags.filter((candidate) => candidate !== tag));
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </Badge>
        ))}
        {props.readOnly ? null : (
          <Input
            id={inputId}
            className="h-8 w-44"
            value={draft}
            placeholder={t('hashtagPlaceholder')}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${inputId}-error` : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (draft.trim().length > 0) {
                add();
              }
            }}
          />
        )}
      </div>
      {invalid ? (
        <p id={`${inputId}-error`} className="text-xs text-destructive">
          {t('invalidHashtag')}
        </p>
      ) : null}
    </div>
  );
}

function Warnings(props: {
  aiWarnings: readonly string[];
  issues: readonly string[];
  forbidden: readonly string[];
  autoShortened: boolean;
}) {
  const t = useTranslations('composer.variants');
  const notes = [
    ...props.issues,
    ...(props.forbidden.length > 0 ? [t('forbidden', { words: props.forbidden.join(', ') })] : []),
    ...props.aiWarnings,
  ];
  if (notes.length === 0 && !props.autoShortened) {
    return null;
  }
  return (
    <section aria-label={t('warnings')} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t('warnings')}</h3>
      <ul className="flex flex-wrap gap-2">
        {props.autoShortened ? (
          <li>
            <Badge variant="muted">{t('autoShortened')}</Badge>
          </li>
        ) : null}
        {notes.map((note) => (
          <li key={note}>
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="size-3" aria-hidden="true" />
              {note}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
