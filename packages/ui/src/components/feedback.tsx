import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn';

const alertVariants = cva(
  'flex gap-3 rounded-md border p-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        info: 'border-border bg-muted text-foreground',
        success: 'border-success/40 bg-success/10 text-foreground',
        destructive: 'border-destructive/40 bg-destructive/10 text-foreground',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

const ICONS = { info: Info, success: CheckCircle2, destructive: AlertCircle } as const;

/** A message in the flow of the page. Errors use role="alert", so they are announced. */
export function Alert({
  variant,
  title,
  children,
  className,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants> & { title?: ReactNode }) {
  const Icon = ICONS[variant ?? 'info'];
  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      <div className="flex flex-col gap-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

const badgeVariants = cva('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary/10 text-primary',
      muted: 'border-border bg-muted text-muted-foreground',
      warning: 'border-transparent bg-warning/15 text-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/** Loading state of a list or page: skeleton rows plus a text for screen readers. */
export function LoadingState({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Alert variant="destructive" title={title}>
      {description}
      {action ? <div className="mt-2">{action}</div> : null}
    </Alert>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}
