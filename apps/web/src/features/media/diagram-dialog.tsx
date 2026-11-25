'use client';

import { mediaDiagram } from '@smp/api-client';
import { DIAGRAM_DESCRIPTION_MAX_LENGTH, DIAGRAM_FORMATS } from '@smp/contracts';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  FormField,
  NativeSelect,
  Textarea,
} from '@smp/ui';
import { ChartNetwork } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

// A diagram drawn by the AI (ADR 0048): the user describes it and picks a format; the API returns
// the new asset, which the library shows once media.process has made its thumbnails.

type DiagramFormat = (typeof DIAGRAM_FORMATS)[number];

const MIN_DESCRIPTION = 3;

export function DiagramDialog(props: { ws: string; onCreated: () => Promise<unknown> }) {
  const t = useTranslations('media.diagram');
  const tActions = useTranslations('actions');
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [format, setFormat] = useState<DiagramFormat>('square');
  const [creating, setCreating] = useState(false);
  const ready = description.trim().length >= MIN_DESCRIPTION;

  const create = async () => {
    setCreating(true);
    try {
      const diagram = await mediaDiagram(props.ws, { description: description.trim(), format });
      toast.success(t('created', { title: diagram.title }));
      setOpen(false);
      setDescription('');
      await props.onCreated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        <ChartNetwork aria-hidden="true" />
        {t('button')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!creating) {
            setOpen(next);
          }
        }}
      >
        <DialogContent closeLabel={tActions('close')}>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !creating) {
                void create();
              }
            }}
          >
            <FormField id="diagram-description" label={t('descriptionLabel')} hint={t('hint')}>
              {(control) => (
                <Textarea
                  {...control}
                  rows={5}
                  value={description}
                  maxLength={DIAGRAM_DESCRIPTION_MAX_LENGTH}
                  placeholder={t('placeholder')}
                  disabled={creating}
                  onChange={(event) => {
                    setDescription(event.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField id="diagram-format" label={t('formatLabel')}>
              {(control) => (
                <NativeSelect
                  {...control}
                  value={format}
                  disabled={creating}
                  onChange={(event) => {
                    setFormat(event.target.value as DiagramFormat);
                  }}
                >
                  {DIAGRAM_FORMATS.map((option) => (
                    <option key={option} value={option}>
                      {t(`formats.${option}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            {creating ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('creating')}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creating}>
                  {tActions('cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!ready} loading={creating}>
                {t('submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
