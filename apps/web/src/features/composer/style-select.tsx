'use client';

import type { StyleDto } from '@smp/contracts';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@smp/ui';
import { useTranslations } from 'next-intl';

// The style dropdown of the briefing (guide step 2.8): the presets under translated names with a
// short description, then the active custom styles of the workspace with their instructions.

const PRESET_KEYS = [
  'professional',
  'storytelling',
  'casual',
  'educational',
  'thought_leadership',
  'promotional',
] as const;
type PresetKey = (typeof PRESET_KEYS)[number];

const isPresetKey = (key: string): key is PresetKey => (PRESET_KEYS as readonly string[]).includes(key);

export function useStyleName(): (style: Pick<StyleDto, 'key' | 'name'>) => string {
  const t = useTranslations('composer.styles');
  return (style) => (isPresetKey(style.key) ? t(`${style.key}.name`) : style.name);
}

export function StyleSelect(props: {
  id: string;
  styles: readonly StyleDto[];
  value: string | null;
  onChange: (styleId: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('composer.styles');
  const presets = props.styles.filter((style) => style.isPreset);
  // Inactive custom styles stay visible only while a post still uses them.
  const custom = props.styles.filter(
    (style) => !style.isPreset && (style.isActive || style.id === props.value),
  );

  return (
    <Select value={props.value ?? undefined} onValueChange={props.onChange} disabled={props.disabled}>
      <SelectTrigger id={props.id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>{t('presets')}</SelectLabel>
          {presets.map((style) => (
            <SelectItem
              key={style.id}
              value={style.id}
              description={isPresetKey(style.key) ? t(`${style.key}.description`) : undefined}
            >
              {isPresetKey(style.key) ? t(`${style.key}.name`) : style.name}
            </SelectItem>
          ))}
        </SelectGroup>
        {custom.length > 0 ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{t('custom')}</SelectLabel>
              {custom.map((style) => (
                <SelectItem key={style.id} value={style.id} description={style.instructions}>
                  {style.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}
