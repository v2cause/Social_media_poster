import { Check } from 'lucide-react';

import { cn } from '../lib/cn';

/** Progress through a fixed number of steps, for example the onboarding. */
export function Steps({ steps, current, label }: { steps: string[]; current: number; label: string }) {
  return (
    <nav aria-label={label}>
      <ol className="flex items-center gap-2">
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={step}
              className="flex flex-1 items-center gap-2"
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                  done && 'border-primary bg-primary text-primary-foreground',
                  active && 'border-primary text-primary',
                  !done && !active && 'border-border text-muted-foreground',
                )}
              >
                {done ? <Check className="size-4" aria-hidden="true" /> : index + 1}
              </span>
              <span
                className={cn('text-sm max-sm:sr-only', active ? 'font-medium' : 'text-muted-foreground')}
              >
                {step}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
