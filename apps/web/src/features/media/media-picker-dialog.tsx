'use client';

import { getMediaListQueryKey, useMediaList } from '@smp/api-client';
import type { MediaAssetDto } from '@smp/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  LoadingState,
  Spinner,
  cn,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { MediaDropzone } from './media-dropzone';
import { MediaThumbnail } from './media-thumbnail';
import { UploadProgressList } from './upload-progress-list';
import { useUploads } from './use-uploads';

// Picks images for a variant (guide step 3.6): the ready images of the library, newest first,
// and an upload right here. Images still being checked appear once they are ready.

const PICKER_LIMIT = 100;
const POLL_MS = 2000;

export function MediaPickerDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ws: string;
  /** Assets the variant already holds; they cannot be picked twice. */
  attached: readonly string[];
  /** How many more the variant takes. */
  remaining: number;
  onPick: (assets: MediaAssetDto[]) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent closeLabel={t('actions.close')} className="max-w-3xl">
        <DialogTitle>{t('media.picker.title')}</DialogTitle>
        <DialogDescription>{t('media.picker.description')}</DialogDescription>
        {props.open ? <Picker {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Picker(props: Parameters<typeof MediaPickerDialog>[0]) {
  const t = useTranslations('media');
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false);
  const library = useMediaList(
    props.ws,
    { limit: PICKER_LIMIT },
    {
      query: {
        refetchInterval: (query) =>
          waiting || query.state.data?.assets.some((asset) => asset.status === 'PROCESSING')
            ? POLL_MS
            : false,
      },
    },
  );
  const uploads = useUploads(props.ws, () => {
    setWaiting(true);
    void queryClient.invalidateQueries({ queryKey: getMediaListQueryKey(props.ws) });
  });
  const assets = library.data?.assets ?? [];
  const ready = assets.filter((asset) => asset.status === 'READY');

  const toggle = (asset: MediaAssetDto) => {
    setSelected((previous) =>
      previous.includes(asset.id)
        ? previous.filter((id) => id !== asset.id)
        : previous.length < props.remaining
          ? [...previous, asset.id]
          : previous,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <MediaDropzone onFiles={uploads.add} compact />
      <UploadProgressList items={uploads.items} onDismiss={uploads.dismiss} />
      {library.isPending ? (
        <LoadingState label={t('loading')} rows={1} />
      ) : (
        <ul className="grid max-h-96 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
          {assets
            .filter((asset) => asset.status === 'READY' || asset.status === 'PROCESSING')
            .map((asset) => {
              const attached = props.attached.includes(asset.id);
              const isSelected = selected.includes(asset.id);
              return (
                <li key={asset.id}>
                  {asset.status === 'READY' ? (
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={t('picker.select', { name: asset.fileName })}
                      disabled={attached}
                      data-testid="picker-item"
                      className={cn(
                        'relative block w-full overflow-hidden rounded-md border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected ? 'border-primary' : 'border-transparent',
                        attached && 'cursor-not-allowed opacity-50',
                      )}
                      onClick={() => {
                        toggle(asset);
                      }}
                    >
                      <MediaThumbnail asset={asset} alt="" aspectRatio={1} sizes="160px" />
                      {isSelected ? (
                        <span className="absolute right-1 top-1 rounded-full bg-primary p-1 text-primary-foreground">
                          <Check className="size-3" aria-hidden="true" />
                        </span>
                      ) : null}
                      {attached ? (
                        <span className="absolute inset-x-0 bottom-0 bg-background/80 px-1 text-xs">
                          {t('picker.attached')}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <div className="flex aspect-square items-center justify-center rounded-md bg-muted p-2 text-center text-xs text-muted-foreground">
                      <Spinner label={t('picker.notReady')} />
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      )}
      {!library.isPending && ready.length === 0 && uploads.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty.description')}</p>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          disabled={selected.length === 0}
          onClick={() => {
            props.onPick(selected.flatMap((id) => ready.filter((asset) => asset.id === id)));
            props.onOpenChange(false);
          }}
        >
          {t('picker.add', { count: selected.length })}
        </Button>
      </DialogFooter>
    </div>
  );
}
