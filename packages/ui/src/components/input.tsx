import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn';

const fieldClasses =
  'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldClasses, 'h-10', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClasses, 'min-h-20', className)} {...props} />;
}

/** A native select: accessible on every device, including screen readers and mobile pickers. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(fieldClasses, 'h-10 pr-8', className)} {...props} />;
}

export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 rounded border-input accent-primary', className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

/**
 * Label, control, hint and error of one form field. The control gets aria-invalid and
 * aria-describedby through the render function, so screen readers announce the error.
 */
export function FormField(props: {
  id: string;
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  children: (control: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactNode;
}) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children({
        id: props.id,
        'aria-invalid': Boolean(props.error),
        'aria-describedby': describedBy,
      })}
      {props.hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={errorId} className="text-sm text-destructive">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
