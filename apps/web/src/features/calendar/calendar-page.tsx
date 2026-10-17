'use client';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
} from '@dnd-kit/core';
import { getPublishingListQueryKey, publishingList, publishingReschedule } from '@smp/api-client';
import type { VariantListItemDto } from '@smp/contracts';
import {
  Button,
  cn,
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
  LoadingState,
  NativeSelect,
} from '@smp/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { VariantStatusIcon } from '@/features/publishing/variant-status';
import { localDateOf, localDateTimeOf } from '@/features/publishing/zoned-time';
import { useErrorMessage } from '@/lib/use-error-message';

import {
  byDay,
  CALENDAR_VIEWS,
  daysOf,
  isMovable,
  moveTo,
  moveToDay,
  periodOf,
  shiftAnchor,
  shortPreview,
  type CalendarView,
  type Move,
} from './calendar-model';

// The calendar of guide step 4.11: month, week and list of the planned and published variants in
// the time zone of the workspace or of the user. A click opens the composer. Dragging a planned
// variant to another day moves it at once and goes back if the API refuses; past days take no
// variant. Keyboard users move a variant with the dialog "Reschedule". Live events of a status
// fetch the period again.

/** The most variants a day of the month shows before "n more". */
const MONTH_DAY_LIMIT = 3;
const PAGE_LIMIT = 500;

type Zone = 'workspace' | 'own';

const noSubscription = () => () => undefined;
const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Checked when a variant is dropped, not while rendering. */
const isPast = (instant: Date): boolean => instant.getTime() <= Date.now();

/** A whole day as a UTC date, for names of weekdays and months that do not depend on a zone. */
const utcDate = (day: string): Date => new Date(`${day}T00:00:00Z`);

export function CalendarPage(props: { ws: string; timeZone: string; canSchedule: boolean }) {
  const t = useTranslations('calendar');
  const states = useTranslations('states');
  const actions = useTranslations('actions');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const now = useNow({ updateInterval: 60_000 });
  const [view, setView] = useState<CalendarView>('month');
  const [zoneChoice, setZoneChoice] = useState<Zone>('workspace');
  // The zone of the browser is known only in the browser.
  const ownZone = useSyncExternalStore(noSubscription, browserTimeZone, () => null);
  const zone = zoneChoice === 'own' && ownZone ? ownZone : props.timeZone;
  const today = localDateOf(now, zone);
  const [anchor, setAnchor] = useState(() => localDateOf(new Date(), props.timeZone));
  const [rescheduling, setRescheduling] = useState<VariantListItemDto | null>(null);
  const [dragged, setDragged] = useState<VariantListItemDto | null>(null);
  // A drag ends with a click on the dragged link, which must not open the composer.
  const justDragged = useRef(false);

  const days = daysOf(view, anchor);
  const period = periodOf(days, zone);
  const params = { order: 'schedule' as const, from: period.from, to: period.to, limit: PAGE_LIMIT };
  const queryKey = [...getPublishingListQueryKey(props.ws, params), 'calendar'];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const items: VariantListItemDto[] = [];
      let cursor: string | null = null;
      do {
        const page = await publishingList(props.ws, cursor ? { ...params, cursor } : params, { signal });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return items;
    },
    placeholderData: keepPreviousData,
  });
  const items = query.data ?? [];
  const perDay = byDay(items, zone);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dayName = (day: string) => format.dateTime(utcDate(day), { dateStyle: 'full', timeZone: 'UTC' });
  const previewOf = (item: VariantListItemDto) =>
    shortPreview(item.preview === '' ? t('noText') : item.preview);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const item = items.find((candidate) => candidate.id === active.id);
      return item ? t('drag.start', { preview: previewOf(item) }) : undefined;
    },
    onDragOver: ({ over }) => (over ? t('drag.over', { day: dayName(String(over.id)) }) : undefined),
    onDragEnd: ({ active, over }) => {
      const item = items.find((candidate) => candidate.id === active.id);
      return item && over
        ? t('drag.end', { preview: previewOf(item), day: dayName(String(over.id)) })
        : undefined;
    },
    onDragCancel: () => t('drag.cancel'),
  };

  /** Moves the variant in the calendar at once and back again if the API refuses. */
  const move = async (item: VariantListItemDto, target: Move) => {
    if (isPast(target.instant)) {
      toast.error(t('reschedule.past'));
      return;
    }
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<VariantListItemDto[]>(queryKey);
    queryClient.setQueryData<VariantListItemDto[]>(queryKey, (current) =>
      current?.map((candidate) =>
        candidate.id === item.id ? { ...candidate, scheduledAt: target.instant.toISOString() } : candidate,
      ),
    );
    try {
      await publishingReschedule(props.ws, item.id, {
        version: item.version,
        localDateTime: target.localDateTime,
        timeZone: target.timeZone,
      });
      toast.success(
        t('reschedule.done', {
          time: format.dateTime(target.instant, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }),
        }),
      );
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      toast.error(t('reschedule.failed', { reason: errorMessage(error) }));
    } finally {
      await queryClient.invalidateQueries({ queryKey: getPublishingListQueryKey(props.ws) });
    }
  };

  const title =
    view === 'week'
      ? format.dateTimeRange(utcDate(days[0] ?? anchor), utcDate(days.at(-1) ?? anchor), {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : format.dateTime(utcDate(`${anchor.slice(0, 7)}-01`), {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });

  const chip = (item: VariantListItemDto) => (
    <EventChip
      key={item.id}
      ws={props.ws}
      item={item}
      zone={zone}
      preview={previewOf(item)}
      movable={props.canSchedule && isMovable(item)}
      justDragged={justDragged}
      onReschedule={() => {
        setRescheduling(item);
      }}
    />
  );

  let body;
  if (query.isPending) {
    body = <LoadingState label={states('loading')} rows={6} />;
  } else if (query.isError) {
    body = (
      <ErrorState
        title={states('error')}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {actions('retry')}
          </Button>
        }
      />
    );
  } else if (view === 'list') {
    const listed = days.filter((day) => (perDay.get(day) ?? []).length > 0);
    body =
      listed.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ol className="flex flex-col gap-4">
          {listed.map((day) => (
            <li key={day}>
              <h3 className={cn('mb-2 text-sm font-semibold', day === today && 'text-primary')}>
                {dayName(day)}
              </h3>
              <ul className="flex flex-col gap-1">{(perDay.get(day) ?? []).map(chip)}</ul>
            </li>
          ))}
        </ol>
      );
  } else {
    body = (
      <div className="overflow-x-auto">
        <div className="grid min-w-[44rem] grid-cols-7 border-l border-t border-border">
          {days.slice(0, 7).map((day) => (
            <div
              key={`head-${day}`}
              className="border-b border-r border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
            >
              {format.dateTime(utcDate(day), { weekday: 'short', timeZone: 'UTC' })}
            </div>
          ))}
          {days.map((day) => {
            const dayItems = perDay.get(day) ?? [];
            const shown = view === 'month' ? dayItems.slice(0, MONTH_DAY_LIMIT) : dayItems;
            return (
              <DayCell
                key={day}
                day={day}
                label={dayName(day)}
                today={day === today}
                past={day < today}
                outside={view === 'month' && day.slice(0, 7) !== anchor.slice(0, 7)}
                tall={view === 'week'}
              >
                <ul className="flex flex-col gap-1">{shown.map(chip)}</ul>
                {dayItems.length > shown.length ? (
                  <button
                    type="button"
                    className="mt-1 text-xs text-muted-foreground hover:underline"
                    onClick={() => {
                      setView('week');
                      setAnchor(day);
                    }}
                  >
                    {t('more', { count: dayItems.length - shown.length })}
                  </button>
                ) : null}
              </DayCell>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('previous')}
            onClick={() => {
              setAnchor((current) => shiftAnchor(view, current, -1));
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setAnchor(today);
            }}
          >
            {t('today')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('next')}
            onClick={() => {
              setAnchor((current) => shiftAnchor(view, current, 1));
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <h2 className="text-lg font-semibold" aria-live="polite">
          {title}
        </h2>
        <div
          role="group"
          aria-label={t('views.label')}
          className="ml-auto flex rounded-md border border-border"
        >
          {CALENDAR_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={view === candidate}
              className={cn(
                'px-3 py-2 text-sm first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                view === candidate ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
              onClick={() => {
                setView(candidate);
              }}
            >
              {t(`views.${candidate}`)}
            </button>
          ))}
        </div>
        <FormField id="calendar-zone" label={<span className="sr-only">{t('timeZone.label')}</span>}>
          {(control) => (
            <NativeSelect
              {...control}
              className="w-auto"
              value={zoneChoice}
              onChange={(event) => {
                setZoneChoice(event.target.value === 'own' ? 'own' : 'workspace');
              }}
            >
              <option value="workspace">{t('timeZone.workspace', { zone: props.timeZone })}</option>
              {ownZone ? <option value="own">{t('timeZone.own', { zone: ownZone })}</option> : null}
            </NativeSelect>
          )}
        </FormField>
      </div>
      <DndContext
        sensors={sensors}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('drag.hint') } }}
        onDragStart={({ active }) => {
          setDragged(items.find((candidate) => candidate.id === active.id) ?? null);
        }}
        onDragCancel={() => {
          setDragged(null);
        }}
        onDragEnd={({ active, over }) => {
          setDragged(null);
          justDragged.current = true;
          setTimeout(() => {
            justDragged.current = false;
          }, 0);
          const item = items.find((candidate) => candidate.id === active.id);
          if (!item?.scheduledAt || !over) {
            return;
          }
          const day = String(over.id);
          if (day !== localDateOf(new Date(item.scheduledAt), zone)) {
            void move(item, moveToDay(item, day, zone));
          }
        }}
      >
        {body}
        <DragOverlay>
          {dragged ? (
            <div className="rounded border border-primary bg-background px-1 py-0.5 text-xs shadow-md">
              {previewOf(dragged)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {rescheduling ? (
        <RescheduleDialog
          item={rescheduling}
          zone={zone}
          preview={previewOf(rescheduling)}
          onClose={() => {
            setRescheduling(null);
          }}
          onSubmit={(target) => {
            setRescheduling(null);
            void move(rescheduling, target);
          }}
        />
      ) : null}
    </div>
  );
}

function DayCell(props: {
  day: string;
  label: string;
  today: boolean;
  past: boolean;
  outside: boolean;
  tall: boolean;
  children: ReactNode;
}) {
  // Past days take no variant.
  const { setNodeRef, isOver } = useDroppable({ id: props.day, disabled: props.past });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col gap-1 border-b border-r border-border p-1',
        props.tall ? 'min-h-72' : 'min-h-28',
        props.outside && 'bg-muted/40',
        props.past && 'opacity-70',
        isOver && 'bg-primary/10 ring-2 ring-inset ring-primary',
      )}
    >
      <time
        dateTime={props.day}
        aria-label={props.label}
        className={cn(
          'self-start rounded-full px-1.5 text-xs',
          props.today ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground',
        )}
      >
        {Number(props.day.slice(8))}
      </time>
      {props.children}
    </div>
  );
}

function EventChip(props: {
  ws: string;
  item: VariantListItemDto;
  zone: string;
  preview: string;
  movable: boolean;
  justDragged: RefObject<boolean>;
  onReschedule: () => void;
}) {
  const { item } = props;
  const t = useTranslations('calendar');
  const platforms = useTranslations('platforms');
  const statuses = useTranslations('posts.status');
  const format = useFormatter();
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: item.id, disabled: !props.movable });
  const time = item.scheduledAt
    ? format.dateTime(new Date(item.scheduledAt), { timeStyle: 'short', timeZone: props.zone })
    : '';
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      className={cn(
        'group flex items-center gap-1 rounded border border-border bg-background text-xs',
        props.movable && 'cursor-grab',
        isDragging && 'opacity-40',
        (item.status === 'CANCELED' || item.status === 'FAILED') && 'border-dashed text-muted-foreground',
      )}
    >
      <Link
        href={`/w/${props.ws}/posts/${item.postId}`}
        aria-label={t('event', {
          time,
          platform: platforms(item.platform),
          preview: props.preview,
          status: statuses(item.status),
        })}
        onClick={(event) => {
          if (props.justDragged.current) {
            event.preventDefault();
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-1 px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlatformMark platform={item.platform} size="xs" />
        <span className="shrink-0 tabular-nums">{time}</span>
        <span className="truncate">{props.preview}</span>
        <VariantStatusIcon status={item.status} className="ml-auto" />
      </Link>
      {props.movable ? (
        <button
          type="button"
          aria-label={t('reschedule.action', { preview: props.preview })}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(event) => {
            // The button opens the dialog; it does not start a drag.
            event.stopPropagation();
          }}
          onClick={props.onReschedule}
        >
          <CalendarClock className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

function RescheduleDialog(props: {
  item: VariantListItemDto;
  zone: string;
  preview: string;
  onClose: () => void;
  onSubmit: (target: Move) => void;
}) {
  const t = useTranslations('calendar.reschedule');
  const actions = useTranslations('actions');
  const local = localDateTimeOf(new Date(props.item.scheduledAt ?? 0), props.zone);
  const [date, setDate] = useState(local.slice(0, 10));
  const [time, setTime] = useState(local.slice(11, 16));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent closeLabel={actions('close')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit(moveTo(props.item, `${date}T${time}`, props.zone));
          }}
        >
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {props.preview} · {t('description', { zone: props.zone })}
          </DialogDescription>
          <div className="flex flex-wrap gap-3">
            <FormField id="reschedule-date" label={t('date')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  required
                  value={date}
                  onChange={(event) => {
                    setDate(event.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField id="reschedule-time" label={t('time')}>
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  required
                  value={time}
                  onChange={(event) => {
                    setTime(event.target.value);
                  }}
                />
              )}
            </FormField>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {actions('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={date === '' || time === ''}>
              {t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
