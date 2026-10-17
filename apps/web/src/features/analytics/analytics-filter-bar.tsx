'use client';

import type { SocialAccountDto } from '@smp/contracts';
import { PLATFORMS, type Platform } from '@smp/platform-rules';
import { Button, Checkbox, FormField, Input, Popover, PopoverContent, PopoverTrigger, cn } from '@smp/ui';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { PlatformMark } from '@/features/publishing/platform-mark';

import {
  DEFAULT_PERIOD,
  PERIOD_PRESETS,
  accountIdsOf,
  partsOf,
  platformsOf,
  toggled,
  type AnalyticsQuery,
  type Period,
  type PeriodProblem,
} from './analytics-filters';

// The filter bar of the analytics views (guide step 5.5): the period (7, 30 or 90 days, or one of
// its own), the platforms and the accounts. Nothing selected means all of them. Accounts of a
// platform that is no longer selected leave the selection, so the filters never contradict.

const segment = (pressed: boolean) =>
  cn(
    'px-3 py-2 text-sm first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    pressed ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
  );

export function AnalyticsFilterBar(props: {
  query: AnalyticsQuery;
  onChange: (patch: Partial<AnalyticsQuery>) => void;
  accounts: readonly SocialAccountDto[];
  /** The period shown now, the start of a period of its own. */
  period: Period | null;
  problem: PeriodProblem | null;
  /** Without the platforms and accounts, for the page of one account. */
  periodOnly?: boolean;
}) {
  const t = useTranslations('analytics.filters');
  const platformNames = useTranslations('platforms');
  const { query, onChange } = props;
  const platforms = platformsOf(query);
  const accountIds = accountIdsOf(query);
  const offered = props.accounts.filter(
    (account) => platforms.length === 0 || platforms.includes(account.platform),
  );
  const filtered = query.period !== DEFAULT_PERIOD || platforms.length > 0 || accountIds.length > 0;

  const togglePlatform = (platform: Platform, on: boolean) => {
    const next = toggled(query.platform, platform, on);
    const selected = partsOf(next);
    const kept =
      selected.length === 0
        ? props.accounts
        : props.accounts.filter((account) => selected.includes(account.platform));
    onChange({
      platform: next,
      accountId: accountIds.filter((id) => kept.some((account) => account.id === id)).join(','),
    });
  };

  return (
    <fieldset className="flex flex-wrap items-end gap-4">
      <legend className="sr-only">{t('title')}</legend>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium" id="analytics-period-label">
          {t('period')}
        </span>
        <div
          role="group"
          aria-labelledby="analytics-period-label"
          className="flex rounded-md border border-border"
        >
          {[...PERIOD_PRESETS, 'custom' as const].map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={query.period === choice}
              className={segment(query.period === choice)}
              onClick={() => {
                // A period of its own starts from the one shown.
                onChange(
                  choice === 'custom'
                    ? { period: choice, from: props.period?.from, to: props.period?.to }
                    : // The default leaves the query string, like the days of a period of its own.
                      {
                        period: choice === DEFAULT_PERIOD ? undefined : choice,
                        from: undefined,
                        to: undefined,
                      },
                );
              }}
            >
              {t(`periods.${choice}`)}
            </button>
          ))}
        </div>
      </div>
      {query.period === 'custom' ? (
        <>
          <FormField id="analytics-from" label={t('from')}>
            {(control) => (
              <Input
                {...control}
                type="date"
                className="w-40"
                value={query.from}
                onChange={(event) => {
                  onChange({ from: event.target.value });
                }}
              />
            )}
          </FormField>
          <FormField
            id="analytics-to"
            label={t('to')}
            error={props.problem ? t(`problems.${props.problem}`) : undefined}
          >
            {(control) => (
              <Input
                {...control}
                type="date"
                className="w-40"
                value={query.to}
                onChange={(event) => {
                  onChange({ to: event.target.value });
                }}
              />
            )}
          </FormField>
        </>
      ) : null}
      {props.periodOnly ? null : (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id="analytics-platforms-label">
              {t('platforms')}
            </span>
            <div
              role="group"
              aria-labelledby="analytics-platforms-label"
              className="flex rounded-md border border-border"
            >
              {PLATFORMS.map((platform) => {
                const pressed = platforms.includes(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    aria-pressed={pressed}
                    aria-label={platformNames(platform)}
                    className={cn(segment(pressed), 'flex items-center gap-2')}
                    onClick={() => {
                      togglePlatform(platform, !pressed);
                    }}
                  >
                    <PlatformMark platform={platform} size="xs" />
                    <span className="hidden sm:inline">{platformNames(platform)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id="analytics-accounts-label">
              {t('accounts')}
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" aria-describedby="analytics-accounts-label">
                  {accountIds.length === 0
                    ? t('allAccounts')
                    : t('someAccounts', { count: accountIds.length })}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="flex max-h-80 flex-col gap-2 overflow-auto">
                {offered.map((account) => (
                  <label key={account.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={accountIds.includes(account.id)}
                      onChange={(event) => {
                        onChange({ accountId: toggled(query.accountId, account.id, event.target.checked) });
                      }}
                    />
                    <PlatformMark platform={account.platform} size="xs" />
                    <span className="truncate">{account.name}</span>
                    {account.handle ? (
                      <span className="truncate text-muted-foreground">@{account.handle}</span>
                    ) : null}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={!filtered}
        onClick={() => {
          onChange({
            period: undefined,
            from: undefined,
            to: undefined,
            platform: undefined,
            accountId: undefined,
          });
        }}
      >
        {t('reset')}
      </Button>
    </fieldset>
  );
}
