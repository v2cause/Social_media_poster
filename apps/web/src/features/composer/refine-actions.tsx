'use client';

import type { Locale, RefineActionDto } from '@smp/contracts';
import type { Platform } from '@smp/platform-rules';
import { Button, Input, Label } from '@smp/ui';
import { Wand2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

// Quick actions and an own instruction for one variant (guide step 2.8, architecture 5.3). Every
// action is one stateless AI call; the result opens in the diff dialog.

const QUICK_ACTIONS = [
  'shorter',
  'longer',
  'more_formal',
  'more_casual',
  'stronger_hook',
  'add_cta',
  'fewer_emojis',
  'translate',
  'rewrite_for_platform',
] as const satisfies readonly RefineActionDto[];

export function RefineActions(props: {
  variantId: string;
  platform: Platform;
  /** The language a translation produces. */
  translateTo: Locale;
  running: boolean;
  disabled: boolean;
  onRefine: (action: RefineActionDto, instruction?: string) => void;
}) {
  const t = useTranslations();
  const [instruction, setInstruction] = useState('');
  const inputId = `refine-instruction-${props.variantId}`;

  const label = (action: (typeof QUICK_ACTIONS)[number]): string => {
    switch (action) {
      case 'translate':
        return t('composer.refine.translate', { language: t(`languages.${props.translateTo}`) });
      case 'rewrite_for_platform':
        return t('composer.refine.rewrite_for_platform', { platform: t(`platforms.${props.platform}`) });
      default:
        return t(`composer.refine.${action}`);
    }
  };

  return (
    <section aria-labelledby={`refine-title-${props.variantId}`} className="flex flex-col gap-3">
      <h3 id={`refine-title-${props.variantId}`} className="text-sm font-medium">
        {t('composer.refine.title')}
      </h3>
      <div className="flex flex-wrap gap-2">
        {QUICK_ACTIONS.map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="outline"
            disabled={props.disabled || props.running}
            onClick={() => {
              props.onRefine(action);
            }}
          >
            {label(action)}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (instruction.trim().length > 0) {
            props.onRefine('custom', instruction.trim());
          }
        }}
      >
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={inputId}>{t('composer.refine.custom')}</Label>
          <Input
            id={inputId}
            value={instruction}
            maxLength={500}
            placeholder={t('composer.refine.customPlaceholder')}
            disabled={props.disabled || props.running}
            onChange={(event) => {
              setInstruction(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={props.disabled || props.running || instruction.trim().length === 0}
        >
          <Wand2 aria-hidden="true" />
          {t('composer.refine.apply')}
        </Button>
      </form>
      {props.running ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('composer.refine.running')}
        </p>
      ) : null}
    </section>
  );
}
