import { Badge, cn } from '@smp/ui';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Hourglass,
  Loader2,
  PencilLine,
  RotateCw,
  Trash2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { VariantStatusDto } from './statuses';

// The status of a variant as badge or icon (guide step 4.11), the same in the post list, the
// calendar and the dashboard. The views fetch their data again on every live event of a status.

const BADGE = {
  DRAFT: 'muted',
  SCHEDULED: 'default',
  QUEUED: 'default',
  PUBLISHING: 'default',
  RETRYING: 'warning',
  PUBLISHED: 'success',
  FAILED: 'destructive',
  NEEDS_ATTENTION: 'warning',
  CANCELED: 'muted',
  DELETED: 'muted',
} as const satisfies Record<VariantStatusDto, 'default' | 'muted' | 'warning' | 'destructive' | 'success'>;

const ICON = {
  DRAFT: PencilLine,
  SCHEDULED: Clock,
  QUEUED: Hourglass,
  PUBLISHING: Loader2,
  RETRYING: RotateCw,
  PUBLISHED: CheckCircle2,
  FAILED: XCircle,
  NEEDS_ATTENTION: AlertTriangle,
  CANCELED: Ban,
  DELETED: Trash2,
} as const satisfies Record<VariantStatusDto, LucideIcon>;

export function VariantStatusIcon(props: { status: VariantStatusDto; className?: string }) {
  const t = useTranslations('posts.status');
  const Icon = ICON[props.status];
  return (
    <Icon
      role="img"
      aria-label={t(props.status)}
      className={cn('size-3.5 shrink-0', props.status === 'PUBLISHING' && 'animate-spin', props.className)}
    />
  );
}

export function VariantStatusBadge(props: { status: VariantStatusDto }) {
  const t = useTranslations('posts.status');
  const Icon = ICON[props.status];
  return (
    <Badge variant={BADGE[props.status]} className="gap-1 whitespace-nowrap">
      <Icon aria-hidden="true" className={cn('size-3', props.status === 'PUBLISHING' && 'animate-spin')} />
      {t(props.status)}
    </Badge>
  );
}
