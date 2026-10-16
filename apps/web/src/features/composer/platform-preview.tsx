'use client';

import { capabilitiesOf, composePostText, type Platform } from '@smp/platform-rules';
import { Card, CardContent, CardHeader, CardTitle } from '@smp/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

// The right column of the composer (guide step 2.8): a simple mockup of the post on its platform,
// folded with "... more" where the feed folds it.

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
  author: string;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const full = composePostText(props.text, props.hashtags);
  const fold = props.platform ? capabilitiesOf(props.platform).text.recommendedLength : undefined;
  const folded = !expanded && fold !== undefined && [...graphemes.segment(full)].length > fold;

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
        </article>
      </CardContent>
    </Card>
  );
}
