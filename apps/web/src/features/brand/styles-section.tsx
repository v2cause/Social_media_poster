'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  getStylesListQueryKey,
  stylesUpdate,
  useStylesCreate,
  useStylesList,
  useStylesUpdate,
} from '@smp/api-client';
import { createStyleSchema, type CreateStyleRequest, type StyleDto } from '@smp/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Label,
  LoadingState,
  Textarea,
  cn,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type DragEvent } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';
import { useFieldError } from '@/lib/use-field-error';

import { moveItem, sortOrderChanges } from './reorder';

// The custom styles of a workspace (guide step 2.9): name and instructions, active or not, and
// their order, which the style dropdown of the composer follows. Owners and admins change them
// (brand_voice.manage); everyone else sees the list.

export function StylesSection(props: { ws: string; canManage: boolean }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const styles = useStylesList(props.ws);
  const update = useStylesUpdate();
  // The order while it is being saved, so the list does not jump back in between.
  const [pending, setPending] = useState<StyleDto[] | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  // The active state a click asked for, shown until the list comes back from the server.
  const [activeOverrides, setActiveOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const isActive = (style: StyleDto): boolean => activeOverrides[style.id] ?? style.isActive;

  const custom = pending ?? (styles.data?.styles ?? []).filter((style) => !style.isPreset);
  const refresh = () => queryClient.invalidateQueries({ queryKey: getStylesListQueryKey(props.ws) });

  const reorder = async (from: number, to: number) => {
    const ordered = moveItem(custom, from, to);
    const changes = sortOrderChanges(ordered);
    if (from === to || changes.length === 0) {
      return;
    }
    setPending(ordered);
    try {
      for (const { item, sortOrder } of changes) {
        await stylesUpdate(props.ws, item.id, { version: item.version, sortOrder });
      }
      toast.success(t('brand.styles.reordered'));
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
    setPending(null);
  };

  const toggle = async (style: StyleDto) => {
    const active = !isActive(style);
    setActiveOverrides((current) => ({ ...current, [style.id]: active }));
    try {
      await update.mutateAsync({
        ws: props.ws,
        styleId: style.id,
        data: { version: style.version, isActive: active },
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
    setActiveOverrides((current) =>
      Object.fromEntries(Object.entries(current).filter(([styleId]) => styleId !== style.id)),
    );
  };

  const dropOn = (event: DragEvent, index: number) => {
    event.preventDefault();
    const from = custom.findIndex((style) => style.id === dragged);
    setDragged(null);
    if (from !== -1) {
      void reorder(from, index);
    }
  };

  let content;
  if (styles.isPending) {
    content = <LoadingState label={t('states.loading')} />;
  } else if (styles.isError) {
    content = <ErrorState title={t('states.error')} />;
  } else if (custom.length === 0) {
    content = <EmptyState title={t('brand.styles.empty')} description={t('brand.styles.emptyHint')} />;
  } else {
    content = (
      <>
        {props.canManage && custom.length > 1 ? (
          <p className="text-xs text-muted-foreground">{t('brand.styles.dragHint')}</p>
        ) : null}
        <ol aria-label={t('brand.styles.list')} className="flex flex-col gap-2" aria-busy={pending !== null}>
          {custom.map((style, index) => (
            <li
              key={style.id}
              draggable={props.canManage && pending === null}
              onDragStart={(event) => {
                setDragged(style.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', style.id);
              }}
              onDragOver={(event) => {
                if (dragged !== null) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                dropOn(event, index);
              }}
              onDragEnd={() => {
                setDragged(null);
              }}
              className={cn(
                'flex items-start gap-3 rounded-md border border-border bg-background p-3',
                dragged === style.id && 'opacity-50',
              )}
            >
              {props.canManage ? (
                <GripVertical
                  className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground"
                  aria-hidden="true"
                />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{style.name}</span>
                  {isActive(style) ? null : <Badge variant="muted">{t('brand.styles.inactive')}</Badge>}
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">{style.instructions}</p>
              </div>
              {props.canManage ? (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  <div className="flex items-center gap-2 px-2">
                    <Checkbox
                      id={`style-active-${style.id}`}
                      checked={isActive(style)}
                      disabled={update.isPending || pending !== null}
                      onChange={() => void toggle(style)}
                    />
                    <Label htmlFor={`style-active-${style.id}`}>{t('brand.styles.active')}</Label>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('brand.styles.moveUp', { name: style.name })}
                    disabled={index === 0 || pending !== null}
                    onClick={() => void reorder(index, index - 1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('brand.styles.moveDown', { name: style.name })}
                    disabled={index === custom.length - 1 || pending !== null}
                    onClick={() => void reorder(index, index + 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <StyleDialog ws={props.ws} style={style} onSaved={refresh} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-lg">{t('brand.styles.title')}</CardTitle>
          <CardDescription>{t('brand.styles.description')}</CardDescription>
        </div>
        {props.canManage ? <StyleDialog ws={props.ws} style={null} onSaved={refresh} /> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{content}</CardContent>
    </Card>
  );
}

/** Creates a style, or edits name and instructions of one. */
function StyleDialog(props: { ws: string; style: StyleDto | null; onSaved: () => Promise<void> }) {
  const t = useTranslations();
  const fieldError = useFieldError();
  const errorMessage = useErrorMessage();
  const create = useStylesCreate();
  const update = useStylesUpdate();
  const [open, setOpen] = useState(false);
  const { style } = props;
  const form = useForm<CreateStyleRequest>({
    resolver: zodResolver(createStyleSchema),
    defaultValues: { name: style?.name ?? '', instructions: style?.instructions ?? '' },
  });
  const idPrefix = `style-${style?.id ?? 'new'}`;

  const submit = form.handleSubmit(async (values) => {
    try {
      if (style) {
        await update.mutateAsync({
          ws: props.ws,
          styleId: style.id,
          data: { version: style.version, ...values },
        });
        toast.success(t('brand.styles.saved'));
      } else {
        await create.mutateAsync({ ws: props.ws, data: values });
        toast.success(t('brand.styles.created'));
        form.reset({ name: '', instructions: '' });
      }
      setOpen(false);
      await props.onSaved();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && style) {
          form.reset({ name: style.name, instructions: style.instructions });
        }
      }}
    >
      {style ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t('brand.styles.editNamed', { name: style.name })}
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('brand.styles.edit')}
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t('brand.styles.new')}
        </Button>
      )}
      <DialogContent closeLabel={t('actions.close')}>
        <DialogTitle>{style ? t('brand.styles.editTitle') : t('brand.styles.createTitle')}</DialogTitle>
        <DialogDescription>{t('brand.styles.instructionsHint')}</DialogDescription>
        <form
          method="post"
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <FormField
            id={`${idPrefix}-name`}
            label={t('brand.styles.name')}
            error={fieldError(form.formState.errors.name, { minimum: 1, maximum: 60 })}
          >
            {(control) => <Input {...control} {...form.register('name')} maxLength={60} />}
          </FormField>
          <FormField
            id={`${idPrefix}-instructions`}
            label={t('brand.styles.instructions')}
            error={fieldError(form.formState.errors.instructions, { minimum: 1, maximum: 2000 })}
          >
            {(control) => (
              <Textarea {...control} {...form.register('instructions')} rows={6} maxLength={2000} />
            )}
          </FormField>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('actions.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" loading={form.formState.isSubmitting}>
              {t('brand.styles.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
