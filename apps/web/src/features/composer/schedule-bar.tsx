'use client';

import {
  getPublishingListQueryKey,
  publishingCancel,
  publishingNow,
  publishingReschedule,
  publishingResolve,
  publishingRetry,
  publishingSchedule,
  useAccountsList,
} from '@smp/api-client';
import type { PlanResultDto, SocialAccountDto } from '@smp/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  FormField,
  Input,
  NativeSelect,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { PlatformMark } from '@/features/publishing/platform-mark';
import { CANCELABLE_STATUSES } from '@/features/publishing/statuses';
import { VariantStatusBadge } from '@/features/publishing/variant-status';
import { instantOf, localDateTimeOf } from '@/features/publishing/zoned-time';
import { useErrorMessage } from '@/lib/use-error-message';

import type { ComposerAction, ComposerState, DraftVariant } from './composer-model';
import {
  accountHintOf,
  defaultPlanTime,
  initialAccountOf,
  isUsable,
  nowStepOf,
  planStepOf,
  type AccountHint,
} from './schedule-model';

// The schedule bar of the composer (guide step 4.11): a date and time in the time zone of the
// workspace for all variants, an account and, if wanted, a time of its own per variant, "plan"
// and "post now". It names accounts that run out or must be connected again and what X has cost
// so far. The status of each variant follows the live events of the publish job.

interface LocalTime {
  date: string;
  time: string;
}

interface RowChoice {
  accountId?: string;
  /** A time of its own; undefined takes the shared one. */
  own?: LocalTime;
}

type Outcome = { variant: DraftVariant; result: PlanResultDto } | { variant: DraftVariant; error: unknown };

const MICROS_PER_USD = 1_000_000;

/** The time the bar starts with: the plan of a variant, else a suggestion. */
function initialTime(variants: readonly DraftVariant[], timeZone: string): LocalTime {
  const planned = variants.find((variant) => variant.publishing.scheduledAt !== null)?.publishing.scheduledAt;
  if (planned) {
    const local = localDateTimeOf(new Date(planned), timeZone);
    return { date: local.slice(0, 10), time: local.slice(11, 16) };
  }
  return defaultPlanTime(new Date(), timeZone);
}

export function ScheduleBar(props: {
  ws: string;
  timeZone: string;
  variants: readonly DraftVariant[];
  /** post.schedule: plan, move and cancel. */
  canSchedule: boolean;
  /** post.publish: post now. */
  canPublish: boolean;
  runAfterSave: <T>(task: (saved: ComposerState) => Promise<T>) => Promise<T | null>;
  apply: (action: ComposerAction) => void;
}) {
  const t = useTranslations('composer.schedule');
  const tRoot = useTranslations();
  const platforms = useTranslations('platforms');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const accounts = useAccountsList(props.ws);
  const [shared, setShared] = useState(() => initialTime(props.variants, props.timeZone));
  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  const [busy, setBusy] = useState(false);
  const [confirmNow, setConfirmNow] = useState(false);
  const all = accounts.data?.items ?? [];

  const choiceOf = (variant: DraftVariant) => choices[variant.id] ?? {};
  const accountIdOf = (variant: DraftVariant): string =>
    choiceOf(variant).accountId ??
    initialAccountOf(
      { platform: variant.platform, socialAccountId: variant.publishing.socialAccountId },
      all,
    );
  const timeOf = (variant: DraftVariant): LocalTime => choiceOf(variant).own ?? shared;
  const choose = (variantId: string, patch: RowChoice) => {
    setChoices((current) => ({ ...current, [variantId]: { ...current[variantId], ...patch } }));
  };

  const toPlan = props.variants.filter(
    (variant) => planStepOf(variant.publishing.status) !== null && accountIdOf(variant) !== '',
  );
  const toPost = props.variants.filter(
    (variant) => nowStepOf(variant.publishing.status) !== null && accountIdOf(variant) !== '',
  );

  /** Runs the requests one after the other behind the pending saves and reports the result. */
  const run = async (
    targets: readonly DraftVariant[],
    request: (variant: DraftVariant) => Promise<PlanResultDto>,
    done: (count: number) => string,
  ) => {
    setBusy(true);
    try {
      const outcomes = await props.runAfterSave(async (saved) => {
        const results: Outcome[] = [];
        for (const target of targets) {
          // The version as the saves before left it.
          const variant = saved.variants.find((candidate) => candidate.id === target.id) ?? target;
          try {
            const result = await request(variant);
            props.apply({ type: 'planned', variant: result.variant });
            results.push({ variant, result });
          } catch (error) {
            results.push({ variant, error });
          }
        }
        return results;
      });
      if (outcomes === null) {
        toast.error(tRoot('composer.save.failed'));
        return;
      }
      const succeeded = outcomes.filter((outcome) => 'result' in outcome);
      if (succeeded.length > 0) {
        toast.success(done(succeeded.length));
      }
      for (const outcome of outcomes) {
        const platform = platforms(outcome.variant.platform);
        if ('error' in outcome) {
          toast.error(t('failed', { platform, reason: errorMessage(outcome.error) }));
        } else {
          for (const warning of outcome.result.warnings) {
            toast.warning(t(`warnings.${warning}`, { platform }));
          }
        }
      }
      await queryClient.invalidateQueries({ queryKey: getPublishingListQueryKey(props.ws) });
    } finally {
      setBusy(false);
    }
  };

  const plan = () =>
    run(
      toPlan,
      (variant) => {
        const at = timeOf(variant);
        const localDateTime = `${at.date}T${at.time}`;
        const socialAccountId = accountIdOf(variant);
        switch (planStepOf(variant.publishing.status)) {
          case 'reschedule':
            return publishingReschedule(props.ws, variant.id, {
              version: variant.version,
              localDateTime,
              timeZone: props.timeZone,
              socialAccountId,
            });
          case 'retry':
            return publishingRetry(props.ws, variant.id, {
              version: variant.version,
              localDateTime,
              timeZone: props.timeZone,
            });
          default:
            return publishingSchedule(props.ws, variant.id, {
              version: variant.version,
              localDateTime,
              timeZone: props.timeZone,
              socialAccountId,
            });
        }
      },
      (count) => t('planned', { count }),
    );

  const postNow = () =>
    run(
      toPost,
      (variant) =>
        nowStepOf(variant.publishing.status) === 'retry'
          ? publishingRetry(props.ws, variant.id, { version: variant.version, timeZone: props.timeZone })
          : publishingNow(props.ws, variant.id, {
              version: variant.version,
              timeZone: props.timeZone,
              socialAccountId: accountIdOf(variant),
            }),
      (count) => t('posting', { count }),
    );

  const timeValid = shared.date !== '' && shared.time !== '';

  return (
    <Card role="region" aria-labelledby="schedule-title">
      <CardHeader>
        <CardTitle id="schedule-title" className="text-base">
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {props.canSchedule ? (
          <div className="flex flex-wrap items-end gap-3">
            <FormField id="schedule-date" label={t('date')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  className="w-44"
                  value={shared.date}
                  onChange={(event) => {
                    setShared((current) => ({ ...current, date: event.target.value }));
                  }}
                />
              )}
            </FormField>
            <FormField id="schedule-time" label={t('time')}>
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  className="w-32"
                  value={shared.time}
                  onChange={(event) => {
                    setShared((current) => ({ ...current, time: event.target.value }));
                  }}
                />
              )}
            </FormField>
            <p className="pb-2 text-sm text-muted-foreground">{t('timeZone', { zone: props.timeZone })}</p>
          </div>
        ) : null}
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {props.variants.map((variant) => (
            <VariantRow
              key={variant.id}
              ws={props.ws}
              variant={variant}
              accounts={all.filter((account) => account.platform === variant.platform)}
              accountId={accountIdOf(variant)}
              own={choiceOf(variant).own}
              shared={shared}
              timeZone={props.timeZone}
              canSchedule={props.canSchedule}
              busy={busy}
              onAccount={(accountId) => {
                choose(variant.id, { accountId });
              }}
              onOwn={(own) => {
                choose(variant.id, { own });
              }}
              onCancel={() =>
                run(
                  [variant],
                  (current) => publishingCancel(props.ws, current.id, { version: current.version }),
                  () => t('canceled'),
                )
              }
              onResolve={(action) =>
                run(
                  [variant],
                  (current) => publishingResolve(props.ws, current.id, { version: current.version, action }),
                  () => t(`resolved.${action}`),
                )
              }
              format={format}
            />
          ))}
        </ul>
      </CardContent>
      {props.canSchedule || props.canPublish ? (
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {props.canPublish ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || toPost.length === 0}
              onClick={() => {
                setConfirmNow(true);
              }}
            >
              {t('now')}
            </Button>
          ) : null}
          {props.canSchedule ? (
            <Button
              type="button"
              disabled={busy || toPlan.length === 0 || !timeValid}
              onClick={() => {
                void plan();
              }}
            >
              {toPlan.length > 0 ? t('planCount', { count: toPlan.length }) : t('plan')}
            </Button>
          ) : null}
        </CardFooter>
      ) : null}
      <Dialog open={confirmNow} onOpenChange={setConfirmNow}>
        <DialogContent closeLabel={tRoot('actions.close')}>
          <DialogTitle>{t('confirmNow.title')}</DialogTitle>
          <DialogDescription>{t('confirmNow.description', { count: toPost.length })}</DialogDescription>
          <ul className="flex flex-col gap-1 text-sm">
            {toPost.map((variant) => (
              <li key={variant.id} className="flex items-center gap-2">
                <PlatformMark platform={variant.platform} />
                {all.find((account) => account.id === accountIdOf(variant))?.name ??
                  platforms(variant.platform)}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tRoot('actions.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmNow(false);
                void postNow();
              }}
            >
              {t('confirmNow.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function VariantRow(props: {
  ws: string;
  variant: DraftVariant;
  /** The accounts of the platform of the variant. */
  accounts: readonly SocialAccountDto[];
  accountId: string;
  own: LocalTime | undefined;
  shared: LocalTime;
  timeZone: string;
  canSchedule: boolean;
  busy: boolean;
  onAccount: (accountId: string) => void;
  onOwn: (own: LocalTime | undefined) => void;
  onCancel: () => Promise<void>;
  onResolve: (action: 'recheck' | 'publish_anyway' | 'discard') => Promise<void>;
  format: ReturnType<typeof useFormatter>;
}) {
  const { variant, format } = props;
  const t = useTranslations('composer.schedule');
  const platforms = useTranslations('platforms');
  const { status } = variant.publishing;
  const platform = platforms(variant.platform);
  const plannable = props.canSchedule && planStepOf(status) !== null;
  const account = props.accounts.find((candidate) => candidate.id === props.accountId);
  const at = props.own ?? props.shared;
  const plannedAt =
    at.date !== '' && at.time !== '' ? instantOf(`${at.date}T${at.time}`, props.timeZone) : null;
  const hint = plannable ? accountHintOf(account, plannedAt) : null;
  const zoned = (instant: string, timeZone: string | null) =>
    format.dateTime(new Date(instant), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timeZone ?? props.timeZone,
    });

  return (
    <li className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-32 items-center gap-2 font-medium">
          <PlatformMark platform={variant.platform} />
          {platform}
        </div>
        <VariantStatusBadge status={status} />
        {variant.publishing.scheduledAt && status !== 'PUBLISHED' ? (
          <span className="text-sm text-muted-foreground">
            {t('plannedFor', {
              time: zoned(variant.publishing.scheduledAt, variant.publishing.scheduledTimezone),
            })}
          </span>
        ) : null}
        {variant.publishing.publishedAt ? (
          <span className="text-sm text-muted-foreground">
            {t('publishedAt', { time: zoned(variant.publishing.publishedAt, null) })}
          </span>
        ) : null}
        {variant.publishing.externalUrl ? (
          <a
            href={variant.publishing.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm hover:underline"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {t('original')}
          </a>
        ) : null}
        {props.canSchedule && CANCELABLE_STATUSES.includes(status) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={props.busy}
            onClick={() => {
              void props.onCancel();
            }}
          >
            {t('cancel')}
          </Button>
        ) : null}
      </div>

      {plannable ? (
        <div className="flex flex-wrap items-end gap-3">
          {props.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('noAccounts', { platform })}{' '}
              <Link href={`/w/${props.ws}/accounts`} className="underline">
                {t('connectAccount')}
              </Link>
            </p>
          ) : (
            <FormField id={`account-${variant.id}`} label={t('account', { platform })}>
              {(control) => (
                <NativeSelect
                  {...control}
                  className="w-64"
                  value={props.accountId}
                  // A retry keeps the account of the failed attempt.
                  disabled={status === 'FAILED'}
                  onChange={(event) => {
                    props.onAccount(event.target.value);
                  }}
                >
                  <option value="">{t('noAccount')}</option>
                  {props.accounts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id} disabled={!isUsable(candidate)}>
                      {isUsable(candidate) ? candidate.name : t('reconnectOption', { name: candidate.name })}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          )}
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={props.own !== undefined}
              onChange={(event) => {
                props.onOwn(event.target.checked ? props.shared : undefined);
              }}
            />
            {t('ownTime')}
          </label>
          {props.own ? (
            <>
              <Input
                type="date"
                aria-label={t('ownDate', { platform })}
                className="w-44"
                value={props.own.date}
                onChange={(event) => {
                  props.onOwn({ ...props.shared, ...props.own, date: event.target.value });
                }}
              />
              <Input
                type="time"
                aria-label={t('ownTimeOf', { platform })}
                className="w-32"
                value={props.own.time}
                onChange={(event) => {
                  props.onOwn({ ...props.shared, ...props.own, time: event.target.value });
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {status === 'NEEDS_ATTENTION' ? (
        <Alert title={t('hints.needsAttention')}>
          {props.canSchedule ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {(['recheck', 'publish_anyway', 'discard'] as const).map((action) => (
                <Button
                  key={action}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={props.busy}
                  onClick={() => {
                    void props.onResolve(action);
                  }}
                >
                  {t(`resolve.${action}`)}
                </Button>
              ))}
            </div>
          ) : null}
        </Alert>
      ) : null}
      {hint && account ? <AccountHintText hint={hint} account={account} format={format} /> : null}
      {plannable && variant.platform === 'X' && account?.costMicros != null ? (
        <p className="text-xs text-muted-foreground">
          {t('hints.xCost', {
            account: account.name,
            amount: format.number(account.costMicros / MICROS_PER_USD, {
              style: 'currency',
              currency: 'USD',
              minimumFractionDigits: 2,
              maximumFractionDigits: 4,
            }),
          })}
        </p>
      ) : null}
    </li>
  );
}

function AccountHintText(props: {
  hint: AccountHint;
  account: SocialAccountDto;
  format: ReturnType<typeof useFormatter>;
}) {
  const t = useTranslations('composer.schedule.hints');
  const date = props.account.accessExpiresAt
    ? props.format.dateTime(new Date(props.account.accessExpiresAt), { dateStyle: 'medium' })
    : '';
  const text =
    props.hint === 'needs-reauth'
      ? t('needsReauth', { account: props.account.name })
      : props.hint === 'expires-before'
        ? t('expiresBefore', { account: props.account.name, date })
        : t('expiring', { account: props.account.name, date });
  return (
    <p className={props.hint === 'expiring' ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
      {text}
    </p>
  );
}
