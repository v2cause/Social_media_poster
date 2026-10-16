'use client';

import { capabilitiesOf, composePostText, type Platform } from '@smp/platform-rules';
import { Card, CardContent, CardHeader, CardTitle } from '@smp/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { MediaThumbnail } from '@/features/media/media-thumbnail';

import type { DraftMedia } from './composer-model';
import { renderedSize } from './media-items';

// The right column of the composer (guide steps 2.8 and 3.6): a simple mockup of the post on its
// platform, folded with "... more" where the feed folds it, with the images as the platform gets
// them: cropped or with bars. Instagram shows the image first, the others below the text.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The first `length` graphemes, so an emoji or accented letter is never cut in half. */
function firstGraphemes(text: string, length: number): string {
  let result = '';
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (count === length) {
      break;
    }
    result += segment;
    count += 1;
  }
  return result;
}

export function PlatformPreview(props: {
  platform: Platform | null;
  text: string;
  hashtags: readonly string[];
  media: readonly DraftMedia[];
  author: string;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const full = composePostText(props.text, props.hashtags);
  const fold = props.platform ? capabilitiesOf(props.platform).text.recommendedLength : undefined;
  const folded = !expanded && fold !== undefined && [...graphemes.segment(full)].length > fold;
  const images =
    props.media.length > 0 && props.platform ? (
      <PreviewImages media={props.media} platform={props.platform} />
    ) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t('composer.preview.title')}
          {props.platform ? ` - ${t(`platforms.${props.platform}`)}` : ''}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <article
          className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4"
          aria-live="off"
        >
          <header className="flex items-center gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary"
              aria-hidden="true"
            >
              {props.author.slice(0, 1).toUpperCase()}
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">{props.author}</span>
              <span className="text-xs text-muted-foreground">{t('composer.preview.now')}</span>
            </div>
          </header>
          {props.platform === 'INSTAGRAM' ? images : null}
          {full.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('composer.preview.empty')}</p>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm">
              {folded ? firstGraphemes(full, fold).trimEnd() : full}
              {folded ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="font-medium text-muted-foreground hover:underline"
                    onClick={() => {
                      setExpanded(true);
                    }}
                  >
                    {t('composer.preview.more')}
                  </button>
                </>
              ) : null}
            </p>
          )}
          {props.platform === 'INSTAGRAM' ? null : images}
        </article>
      </CardContent>
    </Card>
  );
}

/** The first image large, further ones as a row below it, each as the platform gets it. */
function PreviewImages(props: { media: readonly DraftMedia[]; platform: Platform }) {
  const t = useTranslations('media.preview');
  const [first, ...rest] = props.media;
  if (!first) {
    return null;
  }
  const ratioOf = (item: DraftMedia): number => {
    const size = renderedSize(item, props.platform);
    return size?.fits ? size.width / size.height : 1;
  };
  return (
    <div className="flex flex-col gap-1" data-testid="preview-images">
      <MediaThumbnail
        asset={first.asset}
        crop={first.crop}
        letterbox={first.letterbox}
        alt={first.altText ?? first.asset.altText ?? t('image', { position: 1 })}
        aspectRatio={ratioOf(first)}
        sizes="300px"
        className="w-full rounded-md"
      />
      {rest.length > 0 ? (
        <div className="grid grid-cols-4 gap-1">
          {rest.map((item, index) => (
            <MediaThumbnail
              key={item.assetId}
              asset={item.asset}
              crop={item.crop}
              letterbox={item.letterbox}
              alt={item.altText ?? item.asset.altText ?? t('image', { position: index + 2 })}
              aspectRatio={1}
              sizes="80px"
              className="rounded"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
