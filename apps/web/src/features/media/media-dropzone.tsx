'use client';

import { MEDIA_UPLOAD_MIME_TYPES } from '@smp/contracts';
import { Button, cn } from '@smp/ui';
import { ImagePlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

// Drop area and file picker for images (guide step 3.6). The picker is a real button, so the
// area works with the keyboard; dropping files is the shortcut.

export function MediaDropzone(props: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations('media.upload');
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border p-6 text-center transition-colors',
        props.compact ? 'p-4' : 'p-8',
        over && 'border-primary bg-primary/5',
        props.disabled && 'opacity-60',
      )}
      onDragOver={(event) => {
        if (props.disabled) {
          return;
        }
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!props.disabled) {
          props.onFiles([...event.dataTransfer.files]);
        }
      }}
    >
      <ImagePlus className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{t('dropzone')}</p>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.disabled}
        aria-describedby={hintId}
        onClick={() => input.current?.click()}
      >
        {t('button')}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={MEDIA_UPLOAD_MIME_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="media-file-input"
        onChange={(event) => {
          const files = event.target.files ? [...event.target.files] : [];
          // Choosing the same file again fires a change event.
          event.target.value = '';
          if (files.length > 0) {
            props.onFiles(files);
          }
        }}
      />
    </div>
  );
}
