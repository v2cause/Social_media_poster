'use client';

import {
  getDataExportsListQueryKey,
  useDataExportsCreate,
  useDataExportsDownload,
  useDataExportsList,
} from '@smp/api-client';
import { can, type DataExport, type OrganizationDeletionState, type Role } from '@smp/contracts';
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
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { bytesIn } from '@/features/billing/billing-model';
import { useErrorMessage } from '@/lib/use-error-message';

import { openExportOf, POLL_MS, stateOf, type ExportState } from './data-model';
import { DeletionCard } from './deletion-card';

// The data page of an organization for its owners (guide steps 8.1 and 8.2): ask for an export of
// all its data, follow it while it is created, and download it for 24 hours; delete the
// organization or take its deletion back. A download asks the API for a link of five minutes and
// follows it at once; the archive never has a lasting address.

interface DataPageProps {
  organizationId: string;
  organizationName: string;
  role: Role;
  deletion: OrganizationDeletionState | null;
}

const BADGE_VARIANT: Record<ExportState, 'success' | 'warning' | 'destructive' | 'muted'> = {
  waiting: 'muted',
  running: 'warning',
  ready: 'success',
  expired: 'muted',
  failed: 'destructive',
  canceled: 'muted',
};

export function DataPage(props: DataPageProps) {
  const t = useTranslations('data');
  if (!can(props.role, 'org.export')) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <EmptyState title={t('ownersOnly')} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro')}</p>
      </div>
      <ExportCard {...props} />
      {can(props.role, 'org.delete') ? (
        <DeletionCard
          organizationId={props.organizationId}
          organizationName={props.organizationName}
          deletion={props.deletion}
        />
      ) : null}
    </div>
  );
}

function ExportCard({ organizationId, organizationName }: DataPageProps) {
  const t = useTranslations('data');
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const exports = useDataExportsList(organizationId, {
    query: {
      refetchInterval: (query) =>
        query.state.data && openExportOf(query.state.data.items) ? POLL_MS : false,
    },
  });
  const create = useDataExportsCreate();
  const open = exports.data ? openExportOf(exports.data.items) : null;

  const requestExport = async () => {
    try {
      await create.mutateAsync({ org: organizationId });
      toast.success(t('export.requested'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      await queryClient.invalidateQueries({ queryKey: getDataExportsListQueryKey(organizationId) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('export.title')}</CardTitle>
        <CardDescription>{t('export.description', { organization: organizationName })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open ? (
          <Alert>
            <Spinner label={t('export.working')} />
            <span>{t('export.inProgress')}</span>
          </Alert>
        ) : null}
        <p className="text-sm text-muted-foreground">{t('export.availability')}</p>
        {exports.isPending ? (
          <LoadingState label={t('loading')} />
        ) : exports.isError ? (
          <ErrorState title={t('loadError')} description={errorMessage(exports.error)} />
        ) : exports.data.items.length === 0 ? (
          <EmptyState title={t('export.empty')} />
        ) : (
          <ExportTable organizationId={organizationId} items={exports.data.items} />
        )}
      </CardContent>
      <CardFooter>
        <Button onClick={() => void requestExport()} disabled={open !== null || create.isPending}>
          {create.isPending ? <Spinner label={t('export.requesting')} /> : null}
          {t('export.request')}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ExportTable({ organizationId, items }: { organizationId: string; items: DataExport[] }) {
  const t = useTranslations('data');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const download = useDataExportsDownload();
  const queryClient = useQueryClient();

  const fetchArchive = async (exportId: string) => {
    try {
      const link = await download.mutateAsync({ org: organizationId, exportId });
      window.location.assign(link.url);
    } catch (error) {
      toast.error(errorMessage(error));
      await queryClient.invalidateQueries({ queryKey: getDataExportsListQueryKey(organizationId) });
    }
  };

  return (
    <Table>
      <TableCaption className="sr-only">{t('table.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('table.requestedAt')}</TableHead>
          <TableHead>{t('table.status')}</TableHead>
          <TableHead>{t('table.size')}</TableHead>
          <TableHead>{t('table.expiresAt')}</TableHead>
          <TableHead className="text-right">{t('table.action')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const state = stateOf(item);
          const size = item.sizeBytes === null ? null : bytesIn(item.sizeBytes);
          return (
            <TableRow key={item.id}>
              <TableCell>
                {format.dateTime(new Date(item.requestedAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </TableCell>
              <TableCell>
                <Badge variant={BADGE_VARIANT[state]}>{t(`states.${state}`)}</Badge>
              </TableCell>
              <TableCell>
                {size
                  ? format.number(size.value, { style: 'unit', unit: size.unit, maximumFractionDigits: 1 })
                  : '-'}
              </TableCell>
              <TableCell>
                {item.expiresAt && state === 'ready'
                  ? format.dateTime(new Date(item.expiresAt), { dateStyle: 'medium', timeStyle: 'short' })
                  : '-'}
              </TableCell>
              <TableCell className="text-right">
                {state === 'ready' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void fetchArchive(item.id)}
                    disabled={download.isPending}
                  >
                    <Download aria-hidden="true" />
                    {t('export.download')}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
