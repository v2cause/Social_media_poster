'use client';

import { Badge, Input } from '@smp/ui';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type KeyboardEvent } from 'react';

// Terms as chips (guide step 2.9): tone, vocabulary and forbidden words of a brand voice. Enter
// or a comma adds the term, the cross removes it; duplicates are ignored regardless of case.

export function TagInput(props: {
  id: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  max: number;
  maxLength: number;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const t = useTranslations('brand.editor');
  const [draft, setDraft] = useState('');
  const full = props.value.length >= props.max;

  const add = () => {
    const term = draft.trim();
    if (term.length === 0 || full) {
      return;
    }
    if (!props.value.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
      props.onChange([...props.value, term]);
    }
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    } else if (event.key === 'Backspace' && draft === '' && props.value.length > 0) {
      props.onChange(props.value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {props.value.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {props.value.map((term) => (
            <li key={term}>
              <Badge className="gap-1">
                {term}
                {props.disabled ? null : (
                  <button
                    type="button"
                    className="rounded-full hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('removeItem', { item: term })}
                    onClick={() => {
                      props.onChange(props.value.filter((candidate) => candidate !== term));
                    }}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {props.disabled ? null : (
        <Input
          id={props.id}
          value={draft}
          maxLength={props.maxLength}
          disabled={full}
          placeholder={full ? t('full', { max: props.max }) : t('itemPlaceholder')}
          aria-invalid={props['aria-invalid']}
          aria-describedby={props['aria-describedby']}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
      )}
    </div>
  );
}
