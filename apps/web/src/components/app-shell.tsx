'use client';

import { can, type MyMemberships, type Permission, type Role } from '@smp/contracts';
import {
  Button,
  cn,
  Dialog,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SheetContent,
} from '@smp/ui';
import {
  ArrowLeft,
  BarChart3,
  Bell,
  BookUser,
  CalendarDays,
  ChevronsUpDown,
  CreditCard,
  DatabaseBackup,
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  Lightbulb,
  Link2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import type { BillingNotice } from '@/features/billing/billing-model';
import { BillingNoticeBar } from '@/features/billing/billing-notice';
import { DeletionNoticeBar, OrganizationDeletedNotice } from '@/features/data/deletion-notice';
import { LiveEventsProvider } from '@/features/live/live-events-provider';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { useSignOut } from '@/lib/use-sign-out';
import { useStoredFlag } from '@/lib/use-stored-flag';

import { LanguageSwitcher } from './language-switcher';

type NavKey =
  | 'dashboard'
  | 'create'
  | 'calendar'
  | 'posts'
  | 'ideas'
  | 'media'
  | 'analytics'
  | 'accounts'
  | 'brandVoices'
  | 'settings'
  | 'members'
  | 'billing'
  | 'data'
  | 'security'
  | 'notifications';

interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Hidden for roles without this permission (guide step 1.9); the API checks anyway. */
  permission?: Permission;
}

export type ShellArea =
  | {
      kind: 'workspace';
      slug: string;
      workspaceName: string;
      organizationId: string;
      role: Role;
      /** What the subscription needs, shown above every page (guide step 7.4). */
      billingNotice: BillingNotice | null;
      /** Set while the organization waits for its erasure (guide step 8.2). */
      deletion: { eraseAfter: string } | null;
    }
  | {
      kind: 'organization';
      organizationId: string;
      organizationName: string;
      role: Role;
      billingNotice: BillingNotice | null;
      deletion: { eraseAfter: string } | null;
    }
  | { kind: 'account' };

const WORKSPACE_SECTIONS: { key: NavKey; path: string; icon: LucideIcon; permission?: Permission }[] = [
  { key: 'dashboard', path: 'dashboard', icon: LayoutDashboard },
  { key: 'create', path: 'compose', icon: PenSquare, permission: 'post.write' },
  { key: 'calendar', path: 'calendar', icon: CalendarDays },
  { key: 'posts', path: 'posts', icon: FileText },
  { key: 'ideas', path: 'ideas', icon: Lightbulb },
  { key: 'media', path: 'media', icon: ImageIcon },
  { key: 'analytics', path: 'analytics', icon: BarChart3 },
  { key: 'accounts', path: 'accounts', icon: Link2 },
  { key: 'brandVoices', path: 'brand-voices', icon: BookUser },
  { key: 'settings', path: 'settings', icon: Settings },
];

function navItems(area: ShellArea): NavItem[] {
  switch (area.kind) {
    case 'workspace':
      return WORKSPACE_SECTIONS.map((section) => ({
        key: section.key,
        href: `/w/${area.slug}/${section.path}`,
        icon: section.icon,
        permission: section.permission,
      }));
    case 'organization':
      return [
        { key: 'members', href: `/org/${area.organizationId}/members`, icon: Users },
        {
          key: 'billing',
          href: `/org/${area.organizationId}/billing`,
          icon: CreditCard,
          permission: 'billing.manage',
        },
        {
          key: 'data',
          href: `/org/${area.organizationId}/data`,
          icon: DatabaseBackup,
          permission: 'org.export',
        },
      ];
    case 'account':
      return [
        { key: 'security', href: '/account/security', icon: ShieldCheck },
        { key: 'notifications', href: '/account/notifications', icon: Bell },
      ];
  }
}

/** Organization and account pages lead back to a workspace, preferably one of the same organization. */
function backTarget(area: ShellArea, memberships: MyMemberships['memberships']): string | undefined {
  if (area.kind === 'workspace') {
    return undefined;
  }
  const own =
    area.kind === 'organization'
      ? memberships.find((membership) => membership.organizationId === area.organizationId)
      : undefined;
  const workspace = own?.workspaces[0] ?? memberships.flatMap((membership) => membership.workspaces)[0];
  return workspace ? `/w/${workspace.slug}/dashboard` : undefined;
}

const COLLAPSED_KEY = 'smp.sidebar-collapsed';

export function AppShell(props: {
  user: { name: string; email: string };
  memberships: MyMemberships['memberships'];
  area: ShellArea;
  children: ReactNode;
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useStoredFlag(COLLAPSED_KEY);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const role = props.area.kind === 'account' ? undefined : props.area.role;
  const items = navItems(props.area).filter(
    (item) => !item.permission || (role !== undefined && can(role, item.permission)),
  );
  const back = backTarget(props.area, props.memberships);
  const navigation = (compact: boolean) => (
    <nav aria-label={t('shell.navigation')} className="flex flex-col gap-3">
      {back ? (
        <Link
          href={back}
          title={compact ? t('shell.backToWorkspace') : undefined}
          onClick={() => {
            setDrawerOpen(false);
          }}
          className={cn(
            'flex items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            compact && 'justify-center',
          )}
        >
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          <span className={cn(compact && 'sr-only')}>{t('shell.backToWorkspace')}</span>
        </Link>
      ) : null}
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={compact ? t(`nav.${item.key}`) : undefined}
                onClick={() => {
                  setDrawerOpen(false);
                }}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
                  compact && 'justify-center',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className={cn(compact && 'sr-only')}>{t(`nav.${item.key}`)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <LiveEventsProvider slug={props.area.kind === 'workspace' ? props.area.slug : null}>
      {/* The first stop of the keyboard leads past the navigation (WCAG 2.4.1, guide step 8.8). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {t('shell.skipToContent')}
      </a>
      <div className="flex min-h-screen">
        <aside
          className={cn(
            'sticky top-0 flex h-screen shrink-0 flex-col gap-4 border-r border-border p-3 max-md:hidden',
            collapsed ? 'w-16' : 'w-60',
          )}
        >
          <div className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between')}>
            {collapsed ? null : <span className="truncate px-2 text-sm font-semibold">{t('app.name')}</span>}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setCollapsed(!collapsed);
              }}
              aria-label={collapsed ? t('shell.expand') : t('shell.collapse')}
              aria-expanded={!collapsed}
            >
              {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
            </Button>
          </div>
          {navigation(collapsed)}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-3">
            <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 md:hidden"
                  aria-label={t('shell.openNavigation')}
                >
                  <Menu aria-hidden="true" />
                </Button>
              </DialogTrigger>
              <SheetContent closeLabel={t('actions.close')} aria-describedby={undefined}>
                <DialogTitle className="px-2 text-sm font-semibold">{t('app.name')}</DialogTitle>
                {navigation(false)}
              </SheetContent>
            </Dialog>

            <AreaSwitcher area={props.area} memberships={props.memberships} />

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <NotificationBell />
              <LanguageSwitcher signedIn />
              <UserMenu user={props.user} area={props.area} memberships={props.memberships} />
            </div>
          </header>
          {props.area.kind !== 'account' && props.area.deletion ? (
            <DeletionNoticeBar
              eraseAfter={props.area.deletion.eraseAfter}
              organizationId={props.area.organizationId}
              canRestore={can(props.area.role, 'org.delete')}
            />
          ) : props.area.kind !== 'account' &&
            props.area.billingNotice &&
            // The billing page explains it in detail itself.
            !pathname.startsWith(`/org/${props.area.organizationId}/billing`) ? (
            <BillingNoticeBar
              notice={props.area.billingNotice}
              organizationId={props.area.organizationId}
              canManage={can(props.area.role, 'billing.manage')}
            />
          ) : null}
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-6 outline-none max-md:p-4">
            {props.area.kind !== 'account' &&
            props.area.deletion &&
            // Only the data page works while the organization waits for its erasure.
            !pathname.startsWith(`/org/${props.area.organizationId}/data`) ? (
              <OrganizationDeletedNotice
                eraseAfter={props.area.deletion.eraseAfter}
                organizationId={props.area.organizationId}
                canRestore={can(props.area.role, 'org.delete')}
              />
            ) : (
              props.children
            )}
          </main>
        </div>
      </div>
    </LiveEventsProvider>
  );
}

/** Shows where the user is and switches between the workspaces of all organizations. */
function AreaSwitcher({ area, memberships }: { area: ShellArea; memberships: MyMemberships['memberships'] }) {
  const t = useTranslations();
  const label =
    area.kind === 'workspace'
      ? area.workspaceName
      : area.kind === 'organization'
        ? t('shell.organizationArea', { name: area.organizationName })
        : t('shell.accountArea');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="min-w-0 max-w-64 justify-between"
          aria-label={t('shell.workspaceSwitcher')}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {memberships.map((membership, index) => (
          <DropdownMenuGroup key={membership.organizationId}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{membership.organizationName}</DropdownMenuLabel>
            {membership.workspaces.map((workspace) => (
              <DropdownMenuItem key={workspace.id} asChild>
                <Link
                  href={`/w/${workspace.slug}/dashboard`}
                  aria-current={
                    area.kind === 'workspace' && area.slug === workspace.slug ? 'true' : undefined
                  }
                >
                  {workspace.name}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({
  user,
  area,
  memberships,
}: {
  user: { name: string; email: string };
  area: ShellArea;
  memberships: MyMemberships['memberships'];
}) {
  const t = useTranslations('shell');
  const signOut = useSignOut();
  const organizationId = area.kind === 'account' ? memberships[0]?.organizationId : area.organizationId;
  const initials = user.name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('userMenu', { name: user.name })}>
          <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
            {initials || '?'}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
          <span className="block truncate">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account/security">
            <ShieldCheck aria-hidden="true" />
            {t('account')}
          </Link>
        </DropdownMenuItem>
        {organizationId ? (
          <DropdownMenuItem asChild>
            <Link href={`/org/${organizationId}/members`}>
              <Users aria-hidden="true" />
              {t('team')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {area.kind !== 'account' && can(area.role, 'billing.manage') ? (
          <DropdownMenuItem asChild>
            <Link href={`/org/${area.organizationId}/billing`}>
              <CreditCard aria-hidden="true" />
              {t('billing')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>{t('signOut')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
