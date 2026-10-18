'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  getOrganizationInvitationsQueryKey,
  getOrganizationMembersQueryKey,
  useOrganizationChangeMemberRole,
  useOrganizationInvitations,
  useOrganizationInvite,
  useOrganizationLeave,
  useOrganizationMembers,
  useOrganizationRemoveMember,
  useOrganizationResendInvitation,
  useOrganizationRevokeInvitation,
  useOrganizationSetSecurity,
  useOrganizationWorkspaces,
} from '@smp/api-client';
import { can, inviteMemberSchema, ROLES, type InviteMemberRequest, type Role } from '@smp/contracts';
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
  DialogTrigger,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Label,
  LoadingState,
  NativeSelect,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { useErrorMessage } from '@/lib/use-error-message';
import { useFieldError } from '@/lib/use-field-error';

interface TeamPageProps {
  organizationId: string;
  organizationName: string;
  role: Role;
  currentUserId: string;
  /** Whether every member needs a second factor (guide step 8.4). */
  requireTwoFactor: boolean;
}

/** Roles a member may grant: owners every role, admins every role but owner. */
const grantableRoles = (actor: Role): Role[] =>
  actor === 'OWNER' ? [...ROLES] : ROLES.filter((role) => role !== 'OWNER');

/** Members, invitations and leaving (guide step 1.9). Write actions only for owners and admins. */
export function TeamPage(props: TeamPageProps) {
  const t = useTranslations('team');
  const canManage = can(props.role, 'member.manage');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground">
            {t('description', { organization: props.organizationName })}
          </p>
        </div>
        {canManage ? <InviteDialog organizationId={props.organizationId} actorRole={props.role} /> : null}
      </div>
      <MembersTable {...props} canManage={canManage} />
      {canManage ? <OpenInvitations organizationId={props.organizationId} actorRole={props.role} /> : null}
      {can(props.role, 'org.security') ? (
        <TwoFactorRequirementCard organizationId={props.organizationId} required={props.requireTwoFactor} />
      ) : null}
      <LeaveOrganization organizationId={props.organizationId} organizationName={props.organizationName} />
    </div>
  );
}

/**
 * Owners require a second factor of every member (architecture 10, guide step 8.4). Members
 * without one see the organization again once they set it up on their security page.
 */
function TwoFactorRequirementCard({
  organizationId,
  required,
}: {
  organizationId: string;
  required: boolean;
}) {
  const t = useTranslations('team.security');
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const setSecurity = useOrganizationSetSecurity();

  const change = async (requireTwoFactor: boolean) => {
    try {
      await setSecurity.mutateAsync({ org: organizationId, data: { requireTwoFactor } });
      toast.success(requireTwoFactor ? t('nowRequired') : t('nowOptional'));
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t('title')}
          <Badge variant={required ? 'success' : 'muted'}>{required ? t('required') : t('optional')}</Badge>
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant={required ? 'outline' : 'default'}
          disabled={setSecurity.isPending}
          onClick={() => void change(!required)}
        >
          {required ? t('makeOptional') : t('require')}
        </Button>
      </CardContent>
    </Card>
  );
}

function MembersTable(props: TeamPageProps & { canManage: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const members = useOrganizationMembers(props.organizationId);
  const workspaces = useOrganizationWorkspaces(props.organizationId, { query: { enabled: props.canManage } });
  const changeRole = useOrganizationChangeMemberRole();
  const workspaceNames = new Map(
    (workspaces.data?.workspaces ?? []).map((workspace) => [workspace.id, workspace.name]),
  );

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getOrganizationMembersQueryKey(props.organizationId) });

  const onRoleChange = async (membershipId: string, name: string, role: Role) => {
    try {
      await changeRole.mutateAsync({ org: props.organizationId, membershipId, data: { role } });
      toast.success(t('team.roleChanged', { name, role: t(`roles.${role}`) }));
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
  };

  if (members.isPending) {
    return <LoadingState label={t('team.loading')} />;
  }
  if (members.isError) {
    return (
      <ErrorState
        title={t('states.error')}
        description={errorMessage(members.error)}
        action={
          <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
            {t('actions.retry')}
          </Button>
        }
      />
    );
  }
  if (members.data.members.length === 0) {
    return <EmptyState title={t('team.empty')} />;
  }

  return (
    <Table>
      <TableCaption className="sr-only">{t('team.table.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('team.table.name')}</TableHead>
          <TableHead>{t('team.table.email')}</TableHead>
          <TableHead>{t('team.table.role')}</TableHead>
          <TableHead>{t('team.table.workspaces')}</TableHead>
          <TableHead>{t('team.table.joined')}</TableHead>
          {props.canManage ? <TableHead className="text-right">{t('team.table.actions')}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.data.members.map((member) => {
          const isSelf = member.userId === props.currentUserId;
          const manageable =
            props.canManage && !isSelf && (props.role === 'OWNER' || member.role !== 'OWNER');
          const restricted =
            member.workspaceIds.length > 0 && member.role !== 'OWNER' && member.role !== 'ADMIN';
          return (
            <TableRow key={member.id}>
              <TableCell className="font-medium">
                {member.name}
                {isSelf ? (
                  <Badge variant="muted" className="ml-2">
                    {t('team.table.you')}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{member.email}</TableCell>
              <TableCell>
                {manageable ? (
                  <NativeSelect
                    aria-label={t('team.table.roleOf', { name: member.name })}
                    value={member.role}
                    className="h-9 w-40"
                    disabled={changeRole.isPending}
                    onChange={(event) =>
                      void onRoleChange(member.id, member.name, event.target.value as Role)
                    }
                  >
                    {grantableRoles(props.role).map((role) => (
                      <option key={role} value={role}>
                        {t(`roles.${role}`)}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  t(`roles.${member.role}`)
                )}
              </TableCell>
              <TableCell>
                {!restricted
                  ? t('team.table.allWorkspaces')
                  : workspaceNames.size > 0
                    ? member.workspaceIds.map((id) => workspaceNames.get(id) ?? id).join(', ')
                    : t('team.table.someWorkspaces', { count: member.workspaceIds.length })}
              </TableCell>
              <TableCell>{format.dateTime(new Date(member.joinedAt), { dateStyle: 'medium' })}</TableCell>
              {props.canManage ? (
                <TableCell className="text-right">
                  {manageable ? (
                    <RemoveMemberButton
                      organizationId={props.organizationId}
                      membershipId={member.id}
                      name={member.name}
                    />
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function RemoveMemberButton({
  organizationId,
  membershipId,
  name,
}: {
  organizationId: string;
  membershipId: string;
  name: string;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const remove = useOrganizationRemoveMember();
  const [open, setOpen] = useState(false);

  const confirm = async () => {
    try {
      await remove.mutateAsync({ org: organizationId, membershipId });
      toast.success(t('team.remove.done', { name }));
      setOpen(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await queryClient.invalidateQueries({ queryKey: getOrganizationMembersQueryKey(organizationId) });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          {t('team.remove.action')}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogTitle>{t('team.remove.title', { name })}</DialogTitle>
        <DialogDescription>{t('team.remove.description', { name })}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t('actions.cancel')}</Button>
          </DialogClose>
          <Button variant="destructive" loading={remove.isPending} onClick={() => void confirm()}>
            {t('team.remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type InviteForm = z.input<typeof inviteMemberSchema>;

function InviteDialog({ organizationId, actorRole }: { organizationId: string; actorRole: Role }) {
  const t = useTranslations();
  const fieldError = useFieldError();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const invite = useOrganizationInvite();
  const workspaces = useOrganizationWorkspaces(organizationId, { query: { enabled: open } });
  const form = useForm<InviteForm, unknown, InviteMemberRequest>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role: 'EDITOR', workspaceIds: [] },
  });
  const role = useWatch({ control: form.control, name: 'role' });
  const seesAll = role === 'OWNER' || role === 'ADMIN';

  const submit = form.handleSubmit(async (values) => {
    try {
      await invite.mutateAsync({
        org: organizationId,
        data: { ...values, workspaceIds: seesAll ? [] : values.workspaceIds },
      });
      toast.success(t('team.invite.sent', { email: values.email }));
      form.reset();
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: getOrganizationInvitationsQueryKey(organizationId) });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus aria-hidden="true" />
          {t('team.invite.action')}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogTitle>{t('team.invite.title')}</DialogTitle>
        <DialogDescription>{t('team.invite.description')}</DialogDescription>
        <form
          method="post"
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <FormField
            id="invite-email"
            label={t('team.invite.email')}
            error={fieldError(form.formState.errors.email)}
          >
            {(control) => <Input {...control} {...form.register('email')} type="email" autoComplete="off" />}
          </FormField>
          <FormField
            id="invite-role"
            label={t('team.invite.role')}
            error={fieldError(form.formState.errors.role)}
          >
            {(control) => (
              <NativeSelect {...control} {...form.register('role')}>
                {grantableRoles(actorRole).map((value) => (
                  <option key={value} value={value}>
                    {t(`roles.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('team.invite.workspaces')}</legend>
            {seesAll ? (
              <p className="text-sm text-muted-foreground">{t('team.invite.managersSeeAll')}</p>
            ) : workspaces.isPending ? (
              <LoadingState label={t('states.loading')} rows={2} />
            ) : (
              <>
                {(workspaces.data?.workspaces ?? []).map((workspace) => (
                  <div key={workspace.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`invite-ws-${workspace.id}`}
                      value={workspace.id}
                      {...form.register('workspaceIds')}
                    />
                    <Label htmlFor={`invite-ws-${workspace.id}`}>{workspace.name}</Label>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">{t('team.invite.workspacesHint')}</p>
              </>
            )}
          </fieldset>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('actions.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" loading={invite.isPending}>
              {t('team.invite.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OpenInvitations({ organizationId, actorRole }: { organizationId: string; actorRole: Role }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const invitations = useOrganizationInvitations(organizationId);
  const resend = useOrganizationResendInvitation();
  const revoke = useOrganizationRevokeInvitation();

  const run = async (action: 'resend' | 'revoke', invitationId: string) => {
    try {
      if (action === 'resend') {
        await resend.mutateAsync({ org: organizationId, invitationId });
        toast.success(t('team.invitations.resent'));
      } else {
        await revoke.mutateAsync({ org: organizationId, invitationId });
        toast.success(t('team.invitations.revoked'));
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await queryClient.invalidateQueries({ queryKey: getOrganizationInvitationsQueryKey(organizationId) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('team.invitations.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {invitations.isPending ? (
          <LoadingState label={t('team.invitations.loading')} rows={2} />
        ) : invitations.isError ? (
          <ErrorState
            title={t('states.error')}
            description={errorMessage(invitations.error)}
            action={
              <Button variant="outline" size="sm" onClick={() => void invitations.refetch()}>
                {t('actions.retry')}
              </Button>
            }
          />
        ) : invitations.data.invitations.length === 0 ? (
          <EmptyState title={t('team.invitations.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('team.invitations.email')}</TableHead>
                <TableHead>{t('team.invitations.role')}</TableHead>
                <TableHead>{t('team.invitations.invitedBy')}</TableHead>
                <TableHead>{t('team.invitations.expires')}</TableHead>
                <TableHead className="text-right">{t('team.table.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.data.invitations.map((invitation) => {
                const manageable = actorRole === 'OWNER' || invitation.role !== 'OWNER';
                return (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>{t(`roles.${invitation.role}`)}</TableCell>
                    <TableCell>{invitation.invitedBy ?? ''}</TableCell>
                    <TableCell>
                      {invitation.expired ? (
                        <Badge variant="warning">{t('team.invitations.expired')}</Badge>
                      ) : (
                        format.dateTime(new Date(invitation.expiresAt), { dateStyle: 'medium' })
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {manageable ? (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => void run('resend', invitation.id)}>
                            {t('team.invitations.resend')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void run('revoke', invitation.id)}>
                            {t('team.invitations.revoke')}
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function LeaveOrganization({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const leave = useOrganizationLeave();
  const [open, setOpen] = useState(false);

  const confirm = async () => {
    try {
      await leave.mutateAsync({ org: organizationId });
      router.push('/');
      router.refresh();
    } catch (error) {
      setOpen(false);
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base">{t('team.leave.title')}</CardTitle>
        <CardDescription>{t('team.leave.description', { organization: organizationName })}</CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">{t('team.leave.action')}</Button>
          </DialogTrigger>
          <DialogContent closeLabel={t('actions.close')}>
            <DialogTitle>{t('team.leave.title')}</DialogTitle>
            <DialogDescription>
              {t('team.leave.description', { organization: organizationName })}
            </DialogDescription>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t('actions.cancel')}</Button>
              </DialogClose>
              <Button variant="destructive" loading={leave.isPending} onClick={() => void confirm()}>
                {t('team.leave.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
