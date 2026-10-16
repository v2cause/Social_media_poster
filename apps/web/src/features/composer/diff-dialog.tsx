'use client';

import type { GeneratedVariantDto } from '@smp/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@smp/ui';
import { useTranslations } from 'next-intl';

import { diffWords } from './diff';

// The result of a refinement next to the current text (guide step 2.8): removed words struck
// through, new ones highlighted; the user takes it over or discards it.

export function DiffDialog(props: {
  open: boolean;
  before: { text: string; hashtags: readonly string[] };
  after: GeneratedVariantDto | null;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations();
  const parts = props.after ? diffWords(props.before.text, props.after.text) : [];

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onDiscard();
        }
      }}
    >
      <DialogContent closeLabel={t('actions.close')} className="max-w-2xl">
        <DialogTitle>{t('composer.diff.title')}</DialogTitle>
        <DialogDescription>{t('composer.diff.description')}</DialogDescription>
        <div
          className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-4 text-sm"
          data-testid="refine-diff"
        >
          {parts.map((part, index) =>
            part.kind === 'same' ? (
              <span key={index}>{part.text}</span>
            ) : part.kind === 'removed' ? (
              <del key={index} className="bg-destructive/10 text-destructive line-through">
                {part.text}
              </del>
            ) : (
              <ins key={index} className="bg-success/15 no-underline">
                {part.text}
              </ins>
            ),
          )}
        </div>
        {props.after && props.after.hashtags.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('composer.diff.hashtags', { tags: props.after.hashtags.map((tag) => `#${tag}`).join(' ') })}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onDiscard}>
            {t('composer.diff.discard')}
          </Button>
          <Button type="button" onClick={props.onAccept}>
            {t('composer.diff.accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
