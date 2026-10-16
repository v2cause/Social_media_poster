'use client';

import { Button, cn } from '@smp/ui';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useErrorMessage } from '@/lib/use-error-message';

import type { UploadItem } from './upload-queue';

// The uploads of the page with their progress (guide step 3.6). Finished ones can be dismissed;
// the library shows the check that follows.

export function UploadProgressList(props: { items: readonly UploadItem[]; onDismiss: (id: string) => void }) {
  const t = useTranslations('media.upload');
  const errorMessage = useErrorMessage();
  if (props.items.length === 0) {
    return null;
  }
  return (
    <section aria-label={t('listLabel')} className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{t('listLabel')}</h2>
      <ul className="flex flex-col gap-2">
        {props.items.map((item) => {
          const percent = Math.round(item.progress * 100);
          const status =
            item.status === 'uploading'
              ? t('uploading', { percent })
              : item.status === 'failed'
                ? item.error === 'storage'
                  ? t('storageFailed')
                  : errorMessage(item.error ?? 'unknown')
                : t(item.status);
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
              data-testid="upload-item"
              data-status={item.status}
            >
              {item.status === 'done' ? (
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : item.status === 'failed' ? (
                <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate font-medium">{item.name}</span>
                <span
                  className={cn(
                    'text-xs',
                    item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {status}
                </span>
                {item.status === 'uploading' || item.status === 'queued' ? (
                  <div
                    role="progressbar"
                    aria-label={item.name}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${String(percent)}%` }}
                    />
                  </div>
                ) : null}
              </div>
              {item.status === 'done' || item.status === 'failed' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`${t('dismiss')}: ${item.name}`}
                  onClick={() => {
                    props.onDismiss(item.id);
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
