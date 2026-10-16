'use client';

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@smp/ui';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { useFormatter, useNow, useTranslations } from 'next-intl';

import type { SaverStatus } from './use-composer-saver';

/** "Saved 3 seconds ago" below the composer (guide step 2.8). */
export function SaveStatus(props: { status: SaverStatus; dirty: boolean; onRetry: () => void }) {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow({ updateInterval: 5_000 });
  const { status } = props;

  let content;
  if (status.saving) {
    content = (
      <>
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('composer.save.saving')}
      </>
    );
  } else if (status.failed) {
    content = (
      <>
        <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
        {t('composer.save.failed')}
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={props.onRetry}>
          {t('actions.retry')}
        </Button>
      </>
    );
  } else if (props.dirty || !status.savedAt) {
    content = props.dirty ? t('composer.save.unsaved') : null;
  } else {
    content = (
      <>
        <Check className="size-4 text-success" aria-hidden="true" />
        {t('composer.save.saved', {
          // The clock ticks every few seconds, so a fresh save can be newer than "now".
          relative: format.relativeTime(status.savedAt, now > status.savedAt ? now : status.savedAt),
        })}
      </>
    );
  }

  return (
    <p
      role="status"
      className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground"
      data-testid="save-status"
    >
      {content}
    </p>
  );
}

/** The 409 dialog: load the new state or overwrite it with the local changes. */
export function ConflictDialog(props: { open: boolean; onReload: () => void; onOverwrite: () => void }) {
  const t = useTranslations();
  return (
    <Dialog open={props.open}>
      <DialogContent
        closeLabel={t('actions.close')}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle>{t('composer.conflict.title')}</DialogTitle>
        <DialogDescription>{t('composer.conflict.description')}</DialogDescription>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onOverwrite}>
            {t('composer.conflict.overwrite')}
          </Button>
          <Button type="button" onClick={props.onReload}>
            {t('composer.conflict.reload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
