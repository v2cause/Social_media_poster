import type { Platform } from '@smp/platform-rules';
import { cn } from '@smp/ui';
import { useTranslations } from 'next-intl';

// The sign of a platform in lists, cards and the calendar (guide step 4.11): its short name on
// its color. The logos of the platforms are trademarks and are not shipped with the app.

const MARKS = {
  LINKEDIN: { text: 'in', className: 'bg-[#0a66c2] text-white' },
  INSTAGRAM: { text: 'IG', className: 'bg-[#c13584] text-white' },
  FACEBOOK: { text: 'f', className: 'bg-[#1877f2] text-white' },
  X: { text: 'X', className: 'bg-black text-white ring-1 ring-border' },
} as const satisfies Record<Platform, { text: string; className: string }>;

const SIZES = {
  xs: 'size-4 text-[0.5rem]',
  sm: 'size-5 text-[0.625rem]',
  md: 'size-8 text-sm',
} as const;

export function PlatformMark(props: { platform: Platform; size?: keyof typeof SIZES; className?: string }) {
  const t = useTranslations('platforms');
  const mark = MARKS[props.platform];
  return (
    <span
      role="img"
      aria-label={t(props.platform)}
      title={t(props.platform)}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded font-bold leading-none',
        SIZES[props.size ?? 'sm'],
        mark.className,
        props.className,
      )}
    >
      {mark.text}
    </span>
  );
}
