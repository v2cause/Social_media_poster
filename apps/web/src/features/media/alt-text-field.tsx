'use client';

import { ALT_TEXT_MAX_LENGTH } from '@smp/contracts';
import { Button, Label, Textarea } from '@smp/ui';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

// The alt text of an image (guide steps 3.5 and 3.6). With the AI, "Suggest" shows a proposal
// next to the field; it changes nothing until the user accepts it.

export function AltTextField(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Asks the AI for a suggestion; without it there is no button. */
  suggest?: () => Promise<string>;
  hint?: string;
}) {
  const t = useTranslations('media.altText');
  const errorMessage = useErrorMessage();
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const hintId = `${props.id}-hint`;

  const ask = async () => {
    if (!props.suggest) {
      return;
    }
    setSuggesting(true);
    try {
      setSuggestion(await props.suggest());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={props.id}>{t('label')}</Label>
        {props.suggest ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={suggesting}
            disabled={props.disabled}
            onClick={() => {
              void ask();
            }}
          >
            {suggesting ? null : <Sparkles aria-hidden="true" />}
            {suggesting ? t('suggesting') : t('suggest')}
          </Button>
        ) : null}
      </div>
      <Textarea
        id={props.id}
        rows={2}
        maxLength={ALT_TEXT_MAX_LENGTH}
        value={props.value}
        placeholder={t('placeholder')}
        disabled={props.disabled}
        aria-describedby={hintId}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {props.hint ?? t('hint')}
      </p>
      {suggestion !== null ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm"
        >
          <span className="text-xs font-medium text-muted-foreground">{t('suggestion')}</span>
          <p>{suggestion}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                props.onChange(suggestion);
                setSuggestion(null);
              }}
            >
              {t('accept')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSuggestion(null);
              }}
            >
              {t('discard')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
