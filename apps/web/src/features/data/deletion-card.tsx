'use client';

import { useOrganizationDeletionCreate, useOrganizationDeletionRestore } from '@smp/api-client';
import type { OrganizationDeletionState } from '@smp/contracts';
import {
  Alert,
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
  FormField,
  Input,
  Spinner,
} from '@smp/ui';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

import { confirmsName } from './data-model';

// The deletion of an organization on its data page (guide step 8.2, ADR 0037): an owner deletes it
// by typing its name; from then on nobody works in it, and 30 days later it is erased for good.
// Until then an owner takes the deletion back here. Both reload the page, so that the shell shows
// the new state.

export function DeletionCard(props: {
  organizationId: string;
  organizationName: string;
  deletion: OrganizationDeletionState | null;
}) {
  return props.deletion ? (
    <PendingDeletion {...props} deletion={props.deletion} />
  ) : (
    <DeleteOrganization organizationId={props.organizationId} organizationName={props.organizationName} />
  );
}

function DeleteOrganization({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const t = useTranslations('data.deletion');
  const actions = useTranslations('actions');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const remove = useOrganizationDeletionCreate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const confirm = async () => {
    try {
      const deletion = await remove.mutateAsync({ org: organizationId, data: { confirmName: name } });
      setOpen(false);
      toast.success(
        t('deleted', { date: format.dateTime(new Date(deletion.eraseAfter), { dateStyle: 'long' }) }),
      );
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description', { organization: organizationName })}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t('delay')}</p>
      </CardContent>
      <CardFooter>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            setName('');
          }}
        >
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('delete')}
          </Button>
          <DialogContent closeLabel={actions('close')}>
            <DialogTitle>{t('dialogTitle', { organization: organizationName })}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmsName(name, organizationName)) {
                  void confirm();
                }
              }}
            >
              <FormField id="confirm-organization-name" label={t('confirmLabel')}>
                {(control) => (
                  <Input
                    {...control}
                    value={name}
                    autoComplete="off"
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                )}
              </FormField>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {actions('cancel')}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={!confirmsName(name, organizationName) || remove.isPending}
                >
                  {remove.isPending ? <Spinner label={t('deleting')} /> : null}
                  {t('delete')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  );
}

function PendingDeletion({
  organizationId,
  organizationName,
  deletion,
}: {
  organizationId: string;
  organizationName: string;
  deletion: OrganizationDeletionState;
}) {
  const t = useTranslations('data.deletion');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const restore = useOrganizationDeletionRestore();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long' });

  const takeBack = async () => {
    try {
      await restore.mutateAsync({ org: organizationId });
      toast.success(t('restored'));
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>{t('pendingTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <span>
            {t('pending', {
              organization: organizationName,
              deletedAt: date(deletion.deletedAt),
              date: date(deletion.eraseAfter),
            })}
          </span>
        </Alert>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => void takeBack()} disabled={restore.isPending}>
          {restore.isPending ? <Spinner label={t('restoring')} /> : null}
          {t('restore')}
        </Button>
      </CardFooter>
    </Card>
  );
}
