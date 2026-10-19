'use client';

import {
  getBillingOverviewQueryKey,
  useBillingCheckout,
  useBillingInvoices,
  useBillingOverview,
  useBillingPlan,
  useBillingPortal,
} from '@smp/api-client';
import { can, type BillingOverviewDto, type PaidPlanKey, type Role } from '@smp/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
  Spinner,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

import {
  beyondLimitsOf,
  bytesIn,
  fromMinorUnits,
  offeredPlansOf,
  planActionOf,
  shorterHistoryOf,
  usageRowsOf,
  type UsageRow,
} from './billing-model';

// The billing page of an organization for its owners (guide steps 7.4 and 7.5): the current plan
// and its dates, a bar per limit with a request to reduce what lies beyond a limit, the plans
// with checkout or change in place, the customer portal and the invoices. The plan changes only
// with the webhooks of Stripe, so after a payment or a change the page asks again until it sees
// the new plan, for a minute at most.

const POLL_MS = 2000;
const WAIT_MS = 60_000;

interface BillingPageProps {
  organizationId: string;
  organizationName: string;
  role: Role;
  /** The way back from the hosted checkout. */
  checkout: 'success' | 'canceled' | null;
}

/** What the page waits for: a paid subscription after the checkout (null), or a plan after a change. */
interface Awaiting {
  plan: PaidPlanKey | null;
}

const arrived = (overview: BillingOverviewDto | undefined, awaiting: Awaiting): boolean =>
  overview !== undefined &&
  (awaiting.plan === null
    ? overview.hasRunningSubscription && overview.access === 'full'
    : overview.plan.key === awaiting.plan);

export function BillingPage(props: BillingPageProps) {
  const t = useTranslations('billing');
  if (!can(props.role, 'billing.manage')) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <EmptyState title={t('ownersOnly')} />
      </div>
    );
  }
  return <OwnerBilling {...props} />;
}

function OwnerBilling(props: BillingPageProps) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [awaiting, setAwaiting] = useState<Awaiting | null>(
    props.checkout === 'success' ? { plan: null } : null,
  );
  const [expired, setExpired] = useState(false);
  const overview = useBillingOverview(props.organizationId, {
    query: {
      refetchInterval: (query) =>
        awaiting && !expired && !arrived(query.state.data, awaiting) ? POLL_MS : false,
    },
  });
  const done = awaiting !== null && arrived(overview.data, awaiting);
  const waiting = awaiting !== null && !expired && !done;

  // Waits a minute at most; the webhooks of Stripe may take longer, a reload shows them then.
  useEffect(() => {
    if (!awaiting) {
      return;
    }
    const timer = setTimeout(() => {
      setExpired(true);
    }, WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [awaiting]);

  // The shell shows the state of the subscription from the server, once per change.
  const refreshed = useRef<Awaiting | null>(null);
  useEffect(() => {
    if (done && refreshed.current !== awaiting) {
      refreshed.current = awaiting;
      router.refresh();
    }
  }, [done, awaiting, router]);

  if (overview.isPending) {
    return <LoadingState label={t('billing.loading')} />;
  }
  if (overview.isError) {
    return (
      <ErrorState
        title={t('states.error')}
        description={errorMessage(overview.error)}
        action={
          <Button variant="outline" size="sm" onClick={() => void overview.refetch()}>
            {t('actions.retry')}
          </Button>
        }
      />
    );
  }
  const data = overview.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('billing.title')}</h1>
        <p className="text-muted-foreground">
          {t('billing.description', { organization: props.organizationName })}
        </p>
      </div>
      {props.checkout === 'success' && awaiting?.plan === null && waiting ? (
        <Alert variant="success" title={t('billing.checkout.success')}>
          <Spinner label={t('billing.checkout.pending')} />
        </Alert>
      ) : null}
      {props.checkout === 'canceled' ? <Alert title={t('billing.checkout.canceled')} /> : null}
      {!data.billingEnabled ? <Alert title={t('billing.unavailable')} /> : null}
      <CurrentPlan organizationId={props.organizationId} overview={data} />
      <Usage overview={data} />
      <Plans
        organizationId={props.organizationId}
        overview={data}
        changing={waiting ? (awaiting.plan ?? null) : null}
        onChanged={(plan) => {
          setExpired(false);
          setAwaiting({ plan });
        }}
      />
      {data.hasCustomer ? <Invoices organizationId={props.organizationId} /> : null}
    </div>
  );
}

function useMoney() {
  const format = useFormatter();
  return {
    price: (price: NonNullable<BillingOverviewDto['plan']['price']>) =>
      format.number(fromMinorUnits(price.unitAmount, price.currency), {
        style: 'currency',
        currency: price.currency.toUpperCase(),
      }),
    usd: (micros: number) =>
      format.number(micros / 1_000_000, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }),
    bytes: (bytes: number) => {
      const { value, unit } = bytesIn(bytes);
      return format.number(value, { style: 'unit', unit, maximumFractionDigits: 1 });
    },
    date: (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' }),
  };
}

function CurrentPlan({ organizationId, overview }: { organizationId: string; overview: BillingOverviewDto }) {
  const t = useTranslations('billing');
  const money = useMoney();
  const errorMessage = useErrorMessage();
  const portal = useBillingPortal();
  const status = overview.status;

  const openPortal = async () => {
    try {
      const { url } = await portal.mutateAsync({ org: organizationId });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardDescription>{t('current.title')}</CardDescription>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{t(`plans.${overview.plan.key}`)}</CardTitle>
          <Badge
            variant={
              overview.access === 'read_only' ? 'destructive' : status === 'PAST_DUE' ? 'warning' : 'muted'
            }
          >
            {t(`status.${status}`)}
          </Badge>
        </div>
        {overview.plan.price ? (
          <p className="text-sm">
            {t('price', { amount: money.price(overview.plan.price), interval: overview.plan.price.interval })}{' '}
            <span className="text-muted-foreground">{t('current.net')}</span>
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {overview.access === 'read_only' && overview.readOnlySince ? (
          <Alert variant="destructive" title={t('readOnly.title')}>
            {t('readOnly.body', { date: money.date(overview.readOnlySince) })}
          </Alert>
        ) : null}
        {status === 'PAST_DUE' && overview.graceEndsAt && overview.access === 'full' ? (
          <Alert variant="destructive" title={t('pastDue.title')}>
            {t('pastDue.body', { date: money.date(overview.graceEndsAt) })}
          </Alert>
        ) : null}
        {status === 'TRIALING' && overview.trialEndsAt && overview.access === 'full' ? (
          <p className="text-sm text-muted-foreground">
            {t('current.trialEnds', { date: money.date(overview.trialEndsAt) })}
          </p>
        ) : null}
        {overview.hasRunningSubscription && overview.currentPeriodEnd ? (
          <p className="text-sm text-muted-foreground">
            {overview.cancelAtPeriodEnd
              ? t('current.ends', { date: money.date(overview.currentPeriodEnd) })
              : t('current.renews', { date: money.date(overview.currentPeriodEnd) })}
          </p>
        ) : null}
      </CardContent>
      {overview.billingEnabled && overview.hasCustomer ? (
        <CardFooter className="flex-wrap">
          <Button variant="outline" onClick={() => void openPortal()} disabled={portal.isPending}>
            {t('current.manage')}
          </Button>
          <span className="text-sm text-muted-foreground">{t('current.manageHint')}</span>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function Usage({ overview }: { overview: BillingOverviewDto }) {
  const t = useTranslations('billing');
  const money = useMoney();
  const rows = usageRowsOf(overview);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('usage.title')}</CardTitle>
        <CardDescription>
          {t('usage.description', { date: money.date(`${overview.periodStart}T00:00:00Z`) })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {rows.map((row) => (
            <UsageBar key={row.key} row={row} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function UsageBar({ row }: { row: UsageRow }) {
  const t = useTranslations('billing.usage');
  const money = useMoney();
  const format = useFormatter();
  const amount = (value: number) =>
    row.unit === 'bytes'
      ? money.bytes(value)
      : row.unit === 'micros'
        ? money.usd(value)
        : format.number(value);
  const label = t(`labels.${row.key}`);
  const text = t('of', { used: amount(row.used), limit: amount(row.limit) });

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn('tabular-nums', row.state === 'over' && 'font-medium text-destructive')}>
          {text}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={row.percent}
        aria-valuetext={text}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full',
            row.state === 'ok' && 'bg-primary',
            row.state === 'near' && 'bg-warning',
            (row.state === 'full' || row.state === 'over') && 'bg-destructive',
          )}
          style={{ width: `${String(row.percent)}%` }}
        />
      </div>
      <UsageHint row={row} amount={amount} />
    </li>
  );
}

function UsageHint({ row, amount }: { row: UsageRow; amount: (value: number) => string }) {
  const t = useTranslations('billing.usage');
  let hint: string | null = null;
  if (row.key === 'ai') {
    const included = row.included ?? 0;
    hint =
      row.state === 'full'
        ? t('aiFull')
        : row.used > included
          ? t('aiOverage', { amount: amount(row.used - included) })
          : row.limit > included
            ? t('aiIncluded', { included: amount(included), limit: amount(row.limit) })
            : null;
  } else if (row.key === 'xApi') {
    hint = row.state === 'full' || row.state === 'over' ? t('xApiFull') : null;
  } else if (row.state === 'over') {
    hint = row.monthly ? t('overMonthly') : t('over', { limit: amount(row.limit) });
  } else if (row.state === 'full') {
    hint = row.monthly ? t('fullMonthly') : t('full');
  } else if (row.state === 'near') {
    hint = t('near');
  }
  if (!hint) {
    return null;
  }
  return (
    <p
      className={cn(
        'text-xs',
        row.state === 'over' || row.state === 'full' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {hint}
    </p>
  );
}

function Plans(props: {
  organizationId: string;
  overview: BillingOverviewDto;
  changing: PaidPlanKey | null;
  onChanged: (plan: PaidPlanKey) => void;
}) {
  const t = useTranslations('billing');
  const tActions = useTranslations('actions');
  const money = useMoney();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const checkout = useBillingCheckout();
  const change = useBillingPlan();
  const [confirming, setConfirming] = useState<PaidPlanKey | null>(null);
  const plans = offeredPlansOf(props.overview);

  const startCheckout = async (plan: PaidPlanKey) => {
    try {
      const { url } = await checkout.mutateAsync({ org: props.organizationId, data: { plan } });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const changePlan = async (plan: PaidPlanKey) => {
    try {
      await change.mutateAsync({ org: props.organizationId, data: { plan } });
      setConfirming(null);
      toast.success(t('change.done'));
      props.onChanged(plan);
      await queryClient.invalidateQueries({ queryKey: getBillingOverviewQueryKey(props.organizationId) });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const target = plans.find((plan) => plan.key === confirming);
  const beyond = target ? beyondLimitsOf(props.overview, target.limits) : [];
  const history = target ? shorterHistoryOf(props.overview, target.limits) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('offer.title')}</CardTitle>
        <CardDescription>{t('offer.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {plans.map((plan) => {
            const key = plan.key as PaidPlanKey;
            const action = planActionOf(props.overview, key);
            const busy =
              props.changing === key || (checkout.isPending && checkout.variables.data.plan === key);
            return (
              <li
                key={key}
                className={cn(
                  'flex flex-col gap-3 rounded-lg border p-4',
                  action === 'current' ? 'border-primary' : 'border-border',
                )}
              >
                <div>
                  <h3 className="font-semibold">{t(`plans.${key}`)}</h3>
                  <p className="text-sm">
                    {plan.price
                      ? t('price', { amount: money.price(plan.price), interval: plan.price.interval })
                      : t('offer.noPrice')}
                  </p>
                </div>
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {[
                    t('offer.features.workspaces', { count: plan.limits.maxWorkspaces }),
                    t('offer.features.accounts', { count: plan.limits.maxSocialAccounts }),
                    t('offer.features.members', { count: plan.limits.maxMembers }),
                    t('offer.features.posts', { count: plan.limits.scheduledPostsPerMonth }),
                    t('offer.features.storage', { size: money.bytes(plan.limits.storageBytes) }),
                    t('offer.features.ai', { amount: money.usd(plan.limits.aiCreditsMicros) }),
                    t('offer.features.history', { days: plan.limits.analyticsHistoryDays }),
                    ...(plan.limits.xBrowserAllowed ? [t('offer.features.xBrowser')] : []),
                  ].map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto">
                  {busy ? (
                    <Spinner label={t('checkout.pending')} />
                  ) : (
                    <Button
                      className="w-full"
                      variant={action === 'current' ? 'outline' : 'default'}
                      disabled={action === 'current' || action === 'unavailable' || props.changing !== null}
                      aria-label={`${t(`offer.actions.${action}`)}: ${t(`plans.${key}`)}`}
                      onClick={() => {
                        if (action === 'checkout') {
                          void startCheckout(key);
                        } else if (action === 'change') {
                          setConfirming(key);
                        }
                      }}
                    >
                      {t(`offer.actions.${action}`)}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
          }
        }}
      >
        <DialogContent closeLabel={tActions('close')}>
          <DialogTitle>{t('change.title', { plan: confirming ? t(`plans.${confirming}`) : '' })}</DialogTitle>
          <DialogDescription>{t('change.description')}</DialogDescription>
          {beyond.length > 0 ? (
            <Alert variant="destructive" title={t('change.beyond')}>
              <ul className="list-disc pl-4">
                {beyond.map((row) => (
                  <li key={row.key}>
                    {t('change.beyondItem', {
                      label: t(`usage.labels.${row.key}`),
                      used: row.unit === 'bytes' ? money.bytes(row.used) : format.number(row.used),
                      limit: row.unit === 'bytes' ? money.bytes(row.limit) : format.number(row.limit),
                    })}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {history === null ? null : (
            <Alert variant="destructive" title={t('change.history', { days: history })} />
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tActions('cancel')}</Button>
            </DialogClose>
            <Button
              disabled={change.isPending}
              onClick={() => {
                if (confirming) {
                  void changePlan(confirming);
                }
              }}
            >
              {t('change.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Invoices({ organizationId }: { organizationId: string }) {
  const t = useTranslations();
  const money = useMoney();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const invoices = useBillingInvoices(organizationId);

  let content;
  if (invoices.isPending) {
    content = <LoadingState label={t('billing.invoices.loading')} />;
  } else if (invoices.isError) {
    content = <ErrorState title={t('states.error')} description={errorMessage(invoices.error)} />;
  } else if (invoices.data.items.length === 0) {
    content = <EmptyState title={t('billing.invoices.empty')} />;
  } else {
    content = (
      <Table>
        <TableCaption className="sr-only">{t('billing.invoices.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('billing.invoices.number')}</TableHead>
            <TableHead>{t('billing.invoices.date')}</TableHead>
            <TableHead>{t('billing.invoices.total')}</TableHead>
            <TableHead>{t('billing.invoices.status')}</TableHead>
            <TableHead>{t('billing.invoices.links')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.data.items.map((invoice) => (
            <TableRow key={invoice.id}>
              <TableCell className="font-medium">{invoice.number ?? invoice.id}</TableCell>
              <TableCell>{money.date(invoice.createdAt)}</TableCell>
              <TableCell className="tabular-nums">
                {format.number(fromMinorUnits(invoice.total, invoice.currency), {
                  style: 'currency',
                  currency: invoice.currency.toUpperCase(),
                })}
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    invoice.status === 'paid' ? 'success' : invoice.status === 'open' ? 'warning' : 'muted'
                  }
                >
                  {t(`billing.invoices.statuses.${invoice.status ?? 'unknown'}`)}
                </Badge>
              </TableCell>
              <TableCell className="flex gap-3">
                {invoice.hostedInvoiceUrl ? (
                  <a className="underline" href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                    {t('billing.invoices.view')}
                  </a>
                ) : null}
                {invoice.pdfUrl ? (
                  <a className="underline" href={invoice.pdfUrl} target="_blank" rel="noreferrer">
                    {t('billing.invoices.pdf')}
                  </a>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('billing.invoices.title')}</CardTitle>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
