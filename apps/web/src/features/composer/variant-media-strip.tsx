'use client';

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { aiAltText } from '@smp/api-client';
import { MAX_VARIANT_MEDIA, type Locale, type MediaAssetDto } from '@smp/contracts';
import { Badge, Button, cn } from '@smp/ui';
import { AlertTriangle, ArrowLeft, ArrowRight, Crop, GripVertical, ImagePlus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AltTextField } from '@/features/media/alt-text-field';
import { CropDialog } from '@/features/media/crop-dialog';
import { MediaPickerDialog } from '@/features/media/media-picker-dialog';
import { MediaThumbnail } from '@/features/media/media-thumbnail';

import type { DraftMedia, DraftVariant } from './composer-model';
import { renderedSize } from './media-items';

// The media of a variant in the composer (guide step 3.6): a strip in the order the platform
// shows them, sorted by drag and drop or with the keyboard, and below it the selected image with
// its crop for this platform and its alt text. The auto-save stores every change.

const toDraftMedia = (asset: MediaAssetDto): DraftMedia => ({
  assetId: asset.id,
  crop: null,
  letterbox: false,
  altText: null,
  asset,
});

export function VariantMediaStrip(props: {
  ws: string;
  variant: DraftVariant;
  /** The language and topic of the post, for alt text suggestions. */
  language: Locale;
  context: string;
  readOnly: boolean;
  canUseAi: boolean;
  onChange: (media: DraftMedia[]) => void;
}) {
  const t = useTranslations('media.strip');
  const { variant } = props;
  const media = variant.media;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [cropping, setCropping] = useState(false);
  const selectedIndex = Math.max(
    0,
    media.findIndex((item) => item.assetId === selectedId),
  );
  const selected = media[selectedIndex] ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const positionOf = (id: UniqueIdentifier): number => media.findIndex((item) => item.assetId === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dragStart', { position: positionOf(active.id) }),
    onDragOver: ({ over }) => (over ? t('dragOver', { position: positionOf(over.id) }) : undefined),
    onDragEnd: ({ over }) => (over ? t('dragEnd', { position: positionOf(over.id) }) : undefined),
    onDragCancel: () => t('dragCancel'),
  };

  const update = (assetId: string, patch: Partial<DraftMedia>) => {
    props.onChange(media.map((item) => (item.assetId === assetId ? { ...item, ...patch } : item)));
  };
  const move = (from: number, to: number) => {
    if (to >= 0 && to < media.length) {
      props.onChange(arrayMove(media, from, to));
    }
  };

  const fits = selected ? (renderedSize(selected, variant.platform)?.fits ?? true) : true;

  return (
    <section
      aria-labelledby={`variant-media-${variant.id}`}
      className="flex flex-col gap-3 border-t border-border pt-4"
      data-testid="variant-media"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={`variant-media-${variant.id}`} className="text-sm font-medium">
          {t('title')}
        </h3>
        {props.readOnly ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={media.length >= MAX_VARIANT_MEDIA}
            onClick={() => {
              setPicking(true);
            }}
          >
            <ImagePlus aria-hidden="true" />
            {t('add')}
          </Button>
        )}
      </div>

      {media.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements, screenReaderInstructions: { draggable: t('dragHint') } }}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over.id) {
              move(positionOf(active.id) - 1, positionOf(over.id) - 1);
            }
          }}
        >
          <SortableContext items={media.map((item) => item.assetId)} strategy={horizontalListSortingStrategy}>
            <ul className="flex gap-3 overflow-x-auto pb-2" aria-label={t('title')}>
              {media.map((item, index) => (
                <SortableMedia
                  key={item.assetId}
                  item={item}
                  index={index}
                  count={media.length}
                  platform={variant.platform}
                  selected={item.assetId === selected?.assetId}
                  readOnly={props.readOnly}
                  onSelect={() => {
                    setSelectedId(item.assetId);
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {selected ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3" data-testid="selected-media">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {t('position', { position: selectedIndex + 1, count: media.length })}
            </span>
            {selected.crop ? <Badge variant="muted">{t('cropped')}</Badge> : null}
            {selected.letterbox ? <Badge variant="muted">{t('letterbox')}</Badge> : null}
          </div>
          {fits ? null : (
            <p className="flex items-start gap-2 text-sm" role="note">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              {t('needsCrop')}
            </p>
          )}
          {props.readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={fits ? 'outline' : 'default'}
                onClick={() => {
                  setCropping(true);
                }}
              >
                <Crop aria-hidden="true" />
                {t('crop')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={selectedIndex === 0}
                onClick={() => {
                  move(selectedIndex, selectedIndex - 1);
                }}
              >
                <ArrowLeft aria-hidden="true" />
                {t('moveBack')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={selectedIndex === media.length - 1}
                onClick={() => {
                  move(selectedIndex, selectedIndex + 1);
                }}
              >
                <ArrowRight aria-hidden="true" />
                {t('moveForward')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  props.onChange(media.filter((item) => item.assetId !== selected.assetId));
                  setSelectedId(null);
                }}
              >
                <Trash2 aria-hidden="true" />
                {t('remove')}
              </Button>
            </div>
          )}
          <AltTextField
            key={selected.assetId}
            id={`use-alt-text-${variant.id}-${selected.assetId}`}
            value={selected.altText ?? ''}
            disabled={props.readOnly}
            hint={selected.asset.altText ? t('libraryAltText', { text: selected.asset.altText }) : undefined}
            onChange={(value) => {
              update(selected.assetId, { altText: value.length > 0 ? value : null });
            }}
            {...(props.canUseAi && !props.readOnly
              ? {
                  suggest: async () =>
                    (
                      await aiAltText(props.ws, {
                        assetId: selected.assetId,
                        language: props.language,
                        ...(props.context.trim() ? { context: props.context.trim().slice(0, 1000) } : {}),
                      })
                    ).altText,
                }
              : {})}
          />
        </div>
      ) : null}

      <MediaPickerDialog
        open={picking}
        onOpenChange={setPicking}
        ws={props.ws}
        attached={media.map((item) => item.assetId)}
        remaining={MAX_VARIANT_MEDIA - media.length}
        onPick={(assets) => {
          props.onChange([...media, ...assets.map(toDraftMedia)]);
          setSelectedId(assets[0]?.id ?? selectedId);
        }}
      />
      {selected ? (
        <CropDialog
          open={cropping}
          onOpenChange={setCropping}
          platform={variant.platform}
          asset={selected.asset}
          crop={selected.crop}
          letterbox={selected.letterbox}
          onApply={(change) => {
            update(selected.assetId, change);
          }}
        />
      ) : null}
    </section>
  );
}

function SortableMedia(props: {
  item: DraftMedia;
  index: number;
  count: number;
  platform: DraftVariant['platform'];
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations('media.strip');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.item.assetId,
    disabled: props.readOnly,
  });
  const size = renderedSize(props.item, props.platform);
  const position = props.index + 1;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative w-28 shrink-0', isDragging && 'z-10 opacity-80')}
      data-testid="strip-item"
    >
      <button
        type="button"
        aria-pressed={props.selected}
        aria-label={t('select', { position })}
        className={cn(
          'block w-full overflow-hidden rounded-md border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          props.selected ? 'border-primary' : 'border-transparent',
        )}
        onClick={props.onSelect}
      >
        <MediaThumbnail
          asset={props.item.asset}
          crop={props.item.crop}
          letterbox={props.item.letterbox}
          alt=""
          aspectRatio={size?.fits ? size.width / size.height : 1}
          sizes="112px"
        />
      </button>
      <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-xs font-medium">
        {position}
      </span>
      {size && !size.fits ? (
        <span className="absolute right-1 top-1 rounded bg-warning p-0.5 text-white" title={t('needsCrop')}>
          <AlertTriangle className="size-3" aria-hidden="true" />
        </span>
      ) : null}
      {props.readOnly ? null : (
        <button
          type="button"
          className="mt-1 flex w-full cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('dragHandle', { position })}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4 rotate-90" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}
