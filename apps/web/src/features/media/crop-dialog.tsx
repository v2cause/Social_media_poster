'use client';

import type { CropDto, MediaAssetDto } from '@smp/contracts';
import { planRendition, renditionProfileFor, type Platform } from '@smp/platform-rules';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Label,
  cn,
} from '@smp/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Cropper from 'react-easy-crop';

import { areaOf, cropOf, PRESETS, presetOf, ratioOf, type Area, type CropPreset } from './crop';
import { MediaThumbnail } from './media-thumbnail';

// Crop for one platform (guide step 3.6): react-easy-crop on the large thumbnail, with the aspect
// ratios the platform accepts as presets. Where the platform limits the ratio, white bars instead
// of a crop keep the whole image.

export interface CropChange {
  crop: CropDto | null;
  letterbox: boolean;
}

export function CropDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Platform;
  asset: MediaAssetDto;
  crop: CropDto | null;
  letterbox: boolean;
  onApply: (change: CropChange) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent closeLabel={t('actions.close')} className="max-w-2xl">
        <DialogTitle>{t('media.crop.title', { platform: t(`platforms.${props.platform}`) })}</DialogTitle>
        <DialogDescription>{t('media.crop.description')}</DialogDescription>
        {/* Mounted per opening, so the cropper starts from the stored crop. */}
        {props.open ? <CropEditor {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CropEditor(props: Parameters<typeof CropDialog>[0]) {
  const t = useTranslations('media.crop');
  const { asset } = props;
  const image = { width: asset.width ?? 1, height: asset.height ?? 1 };
  const source = asset.thumbnails.at(-1)?.url ?? '';
  const [preset, setPreset] = useState<CropPreset>(() => presetOf(props.crop, props.platform, image));
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(props.crop ? areaOf(props.crop, image) : null);
  const [letterbox, setLetterbox] = useState(props.letterbox);
  const profile = renditionProfileFor(props.platform);
  const limitsRatio = profile.aspectRatio !== undefined;
  // The whole image with bars, at the ratio the rendition gets.
  const barred = planRendition(image, { crop: null, letterbox: true }, profile);
  const barredRatio = barred.ok ? barred.plan.width / barred.plan.height : image.width / image.height;

  const apply = (change: CropChange) => {
    props.onApply(change);
    props.onOpenChange(false);
  };

  return (
    <div className="flex flex-col gap-4">
      {limitsRatio ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id="crop-letterbox"
            checked={letterbox}
            onChange={(event) => {
              setLetterbox(event.target.checked);
            }}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="crop-letterbox">{t('letterbox')}</Label>
            <p className="text-xs text-muted-foreground">{t('letterboxHint')}</p>
          </div>
        </div>
      ) : null}

      {letterbox ? (
        <MediaThumbnail asset={asset} alt="" letterbox aspectRatio={barredRatio} className="mx-auto h-80" />
      ) : (
        <>
          <div role="group" aria-label={t('ratio')} className="flex flex-wrap gap-2">
            {PRESETS[props.platform].map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={preset === option ? 'default' : 'outline'}
                aria-pressed={preset === option}
                onClick={() => {
                  setPreset(option);
                  setPosition({ x: 0, y: 0 });
                  setZoom(1);
                }}
              >
                {t(`presets.${option}`)}
              </Button>
            ))}
          </div>
          <div className="relative h-80 overflow-hidden rounded-md bg-muted" data-testid="crop-area">
            <Cropper
              image={source}
              aspect={ratioOf(preset, image)}
              crop={position}
              zoom={zoom}
              maxZoom={4}
              onCropChange={setPosition}
              onZoomChange={setZoom}
              onCropComplete={(percentages) => {
                setArea(percentages);
              }}
              {...(props.crop && preset === presetOf(props.crop, props.platform, image)
                ? { initialCroppedAreaPercentages: areaOf(props.crop, image) }
                : {})}
            />
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="crop-zoom">{t('zoom')}</Label>
            <input
              id="crop-zoom"
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              className={cn('flex-1 accent-primary')}
              onChange={(event) => {
                setZoom(Number(event.target.value));
              }}
            />
          </div>
        </>
      )}

      <DialogFooter className="flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            apply({ crop: null, letterbox: false });
          }}
        >
          {t('whole')}
        </Button>
        <Button
          type="button"
          disabled={!letterbox && area === null}
          onClick={() => {
            apply(
              letterbox || !area
                ? { crop: null, letterbox: true }
                : { crop: cropOf(area, image, ratioOf(preset, image)), letterbox: false },
            );
          }}
        >
          {t('apply')}
        </Button>
      </DialogFooter>
    </div>
  );
}
