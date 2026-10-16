'use client';

import { aiAltText, mediaRemove, mediaUpdate } from '@smp/api-client';
import type { MediaAssetDto } from '@smp/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Spinner,
} from '@smp/ui';
import { ImageOff, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

import { AltTextField } from './alt-text-field';
import { MediaThumbnail } from './media-thumbnail';

// One asset of the library (guide step 3.6): thumbnail, status, size, use, alt text and delete.

const STATUS_BADGE = {
  PENDING_UPLOAD: 'muted',
  PROCESSING: 'muted',
  READY: 'default',
  REJECTED: 'destructive',
} as const;

export function MediaCard(props: {
  ws: string;
  asset: MediaAssetDto;
  canWrite: boolean;
  canUseAi: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations('media');
  const tActions = useTranslations('actions');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const { asset } = props;
  const [altText, setAltText] = useState(asset.altText ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const changed = altText.trim() !== (asset.altText ?? '');

  const saveAltText = async () => {
    setSaving(true);
    try {
      await mediaUpdate(props.ws, asset.id, { version: asset.version, altText: altText.trim() || null });
      toast.success(t('altText.saved'));
      await props.onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await mediaRemove(props.ws, asset.id);
      setConfirmDelete(false);
      toast.success(t('delete.done'));
      await props.onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card data-testid="media-card" data-status={asset.status} className="flex flex-col overflow-hidden">
      {asset.status === 'READY' ? (
        <MediaThumbnail
          asset={asset}
          alt={asset.altText ?? asset.fileName}
          aspectRatio={4 / 3}
          sizes="(min-width: 1280px) 25vw, (min-width: 768px) 33vw, 100vw"
        />
      ) : (
        <div className="flex aspect-[4/3] items-center justify-center bg-muted p-4 text-center text-sm text-muted-foreground">
          {asset.status === 'REJECTED' ? (
            <div className="flex flex-col items-center gap-2">
              <ImageOff className="size-6" aria-hidden="true" />
              <span>
                {asset.rejectReason ? t(`rejectReasons.${asset.rejectReason}`) : t('status.REJECTED')}
              </span>
            </div>
          ) : (
            <Spinner label={t(`status.${asset.status}`)} />
          )}
        </div>
      )}
      <CardContent className="flex flex-1 flex-col gap-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={asset.fileName}>
              {asset.fileName}
            </p>
            <p className="text-xs text-muted-foreground">
              {asset.width && asset.height
                ? `${t('dimensions', { width: asset.width, height: asset.height })}, `
                : ''}
              {asset.sizeBytes !== null
                ? asset.sizeBytes < 1024 * 1024
                  ? format.number(Math.ceil(asset.sizeBytes / 1024), { style: 'unit', unit: 'kilobyte' })
                  : format.number(asset.sizeBytes / (1024 * 1024), {
                      style: 'unit',
                      unit: 'megabyte',
                      maximumFractionDigits: 1,
                    })
                : ''}
            </p>
          </div>
          <Badge variant={STATUS_BADGE[asset.status]} className="shrink-0 whitespace-nowrap">
            {t(`status.${asset.status}`)}
          </Badge>
        </div>
        {asset.status === 'READY' ? (
          <>
            <p className="text-xs text-muted-foreground">{t('usage', { count: asset.usageCount })}</p>
            <AltTextField
              id={`alt-text-${asset.id}`}
              value={altText}
              disabled={!props.canWrite || saving}
              onChange={setAltText}
              {...(props.canUseAi && props.canWrite
                ? {
                    suggest: async () => (await aiAltText(props.ws, { assetId: asset.id })).altText,
                  }
                : {})}
            />
          </>
        ) : null}
        {props.canWrite ? (
          <div className="mt-auto flex flex-wrap justify-end gap-2">
            {asset.status === 'READY' ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!changed}
                loading={saving}
                onClick={() => {
                  void saveAltText();
                }}
              >
                {t('altText.save')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${t('delete.button')}: ${asset.fileName}`}
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              <Trash2 aria-hidden="true" />
              {t('delete.button')}
            </Button>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent closeLabel={tActions('close')}>
          <DialogTitle>{t('delete.title')}</DialogTitle>
          <DialogDescription>{t('delete.description', { name: asset.fileName })}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tActions('cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              loading={deleting}
              onClick={() => {
                void remove();
              }}
            >
              {t('delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
