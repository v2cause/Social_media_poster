'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  getBrandVoicesListQueryKey,
  getBrandVoicesVersionsQueryKey,
  useBrandVoicesCreate,
  useBrandVoicesUpdate,
} from '@smp/api-client';
import { EMOJI_POLICIES, HASHTAG_POLICIES, LOCALES, type BrandVoiceDto, type Locale } from '@smp/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  FormField,
  Input,
  Label,
  NativeSelect,
  Textarea,
} from '@smp/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';
import { useFieldError } from '@/lib/use-field-error';

import { TagInput } from './tag-input';
import {
  toVoiceContent,
  toVoiceForm,
  VOICE_LIMITS,
  voiceFormSchema,
  type VoiceForm,
  type VoiceFormValues,
} from './voice-form';
import { VoiceTest } from './voice-test';
import { VoiceVersions } from './voice-versions';

// The brand voice editor (guide step 2.9): name, description, tone, do and don't lists,
// vocabulary, forbidden words, emoji and hashtag policy, three to five example posts and the
// language. Saving changed content creates a new version; the test and the version history sit
// next to the form.

/** The form path of an example post, typed the way react-hook-form expects it. */
const exampleField = (index: number) => `examplePosts.${String(index)}.text` as `examplePosts.${number}.text`;

export interface VoiceEditorPageProps {
  ws: string;
  /** The saved voice, or null for a new one. */
  voice: BrandVoiceDto | null;
  contentLanguage: Locale;
  /** brand_voice.manage; without it the voice is read-only. */
  canManage: boolean;
}

export function VoiceEditorPage(props: VoiceEditorPageProps) {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const fieldError = useFieldError();
  const errorMessage = useErrorMessage();
  const create = useBrandVoicesCreate();
  const update = useBrandVoicesUpdate();
  const [voice, setVoice] = useState(props.voice);
  const readOnly = !props.canManage;
  const form = useForm<VoiceForm, unknown, VoiceFormValues>({
    resolver: zodResolver(voiceFormSchema),
    defaultValues: toVoiceForm(props.voice, props.contentLanguage),
  });
  const examples = useFieldArray({ control: form.control, name: 'examplePosts' });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (!isDirty || readOnly) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [isDirty, readOnly]);

  const refresh = async (saved: BrandVoiceDto) => {
    await queryClient.invalidateQueries({ queryKey: getBrandVoicesListQueryKey(props.ws) });
    await queryClient.invalidateQueries({ queryKey: getBrandVoicesVersionsQueryKey(props.ws, saved.id) });
  };

  const submit = form.handleSubmit(async (values) => {
    const content = toVoiceContent(values);
    try {
      if (voice) {
        const saved = await update.mutateAsync({
          ws: props.ws,
          brandVoiceId: voice.id,
          data: { version: voice.version, content, isDefault: values.isDefault },
        });
        setVoice(saved);
        form.reset(toVoiceForm(saved, props.contentLanguage));
        toast.success(t('brand.editor.saved'));
        await refresh(saved);
      } else {
        const created = await create.mutateAsync({
          ws: props.ws,
          data: { content, isDefault: values.isDefault },
        });
        // The new address renders the saved voice with its test and versions.
        form.reset(toVoiceForm(created, props.contentLanguage));
        toast.success(t('brand.editor.created'));
        await refresh(created);
        router.replace(`/w/${props.ws}/brand-voices/${created.id}`);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  });

  const setArchived = async (archived: boolean) => {
    if (!voice) {
      return;
    }
    try {
      const saved = await update.mutateAsync({
        ws: props.ws,
        brandVoiceId: voice.id,
        data: { version: voice.version, archived },
      });
      setVoice(saved);
      // An archived voice is no longer the default; the other fields keep their edits.
      form.resetField('isDefault', { defaultValue: saved.isDefault });
      toast.success(archived ? t('brand.editor.archivedToast') : t('brand.editor.unarchivedToast'));
      await refresh(saved);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const rulesLimits = { maximum: VOICE_LIMITS.rules.items, length: VOICE_LIMITS.rules.length };

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/w/${props.ws}/brand-voices`}
        className="flex items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t('brand.editor.back')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{voice ? voice.name : t('brand.editor.newTitle')}</h1>
          {voice?.isDefault ? <Badge>{t('brand.voices.default')}</Badge> : null}
          {voice?.archived ? <Badge variant="muted">{t('brand.voices.archived')}</Badge> : null}
        </div>
        {voice && !readOnly ? (
          <Button
            type="button"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void setArchived(!voice.archived)}
          >
            {voice.archived ? t('brand.editor.unarchive') : t('brand.editor.archive')}
          </Button>
        ) : null}
      </div>
      {readOnly ? <Alert>{t('brand.editor.readOnly')}</Alert> : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <form
          method="post"
          className="flex flex-col gap-6"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <fieldset disabled={readOnly} className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('brand.editor.basics')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <FormField
                  id="voice-name"
                  label={t('brand.editor.name')}
                  error={fieldError(errors.name, { minimum: 1, maximum: VOICE_LIMITS.name })}
                >
                  {(control) => (
                    <Input {...control} {...form.register('name')} maxLength={VOICE_LIMITS.name} />
                  )}
                </FormField>
                <FormField
                  id="voice-description"
                  label={t('brand.editor.description')}
                  hint={t('brand.editor.descriptionHint')}
                  error={fieldError(errors.description, { maximum: VOICE_LIMITS.description })}
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      {...form.register('description')}
                      rows={3}
                      maxLength={VOICE_LIMITS.description}
                    />
                  )}
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField id="voice-language" label={t('brand.editor.language')}>
                    {(control) => (
                      <NativeSelect {...control} {...form.register('language')}>
                        {LOCALES.map((locale) => (
                          <option key={locale} value={locale}>
                            {t(`languages.${locale}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </FormField>
                  <div className="flex items-center gap-2 sm:pt-7">
                    <Checkbox id="voice-default" {...form.register('isDefault')} disabled={voice?.archived} />
                    <Label htmlFor="voice-default">{t('brand.editor.isDefault')}</Label>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('brand.editor.rules')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <FormField id="voice-tone" label={t('brand.editor.tone')} hint={t('brand.editor.toneHint')}>
                  {(control) => (
                    <Controller
                      control={form.control}
                      name="tone"
                      render={({ field }) => (
                        <TagInput
                          {...control}
                          value={field.value}
                          onChange={field.onChange}
                          max={VOICE_LIMITS.tone.items}
                          maxLength={VOICE_LIMITS.tone.length}
                          disabled={readOnly}
                        />
                      )}
                    />
                  )}
                </FormField>
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormField
                    id="voice-dos"
                    label={t('brand.editor.dos')}
                    hint={t('brand.editor.dosHint')}
                    error={fieldError(errors.dos, rulesLimits)}
                  >
                    {(control) => <Textarea {...control} {...form.register('dos')} rows={5} />}
                  </FormField>
                  <FormField
                    id="voice-donts"
                    label={t('brand.editor.donts')}
                    hint={t('brand.editor.dontsHint')}
                    error={fieldError(errors.donts, rulesLimits)}
                  >
                    {(control) => <Textarea {...control} {...form.register('donts')} rows={5} />}
                  </FormField>
                </div>
                <FormField
                  id="voice-vocabulary"
                  label={t('brand.editor.vocabulary')}
                  hint={t('brand.editor.vocabularyHint')}
                >
                  {(control) => (
                    <Controller
                      control={form.control}
                      name="vocabulary"
                      render={({ field }) => (
                        <TagInput
                          {...control}
                          value={field.value}
                          onChange={field.onChange}
                          max={VOICE_LIMITS.vocabulary.items}
                          maxLength={VOICE_LIMITS.vocabulary.length}
                          disabled={readOnly}
                        />
                      )}
                    />
                  )}
                </FormField>
                <FormField
                  id="voice-forbidden"
                  label={t('brand.editor.forbiddenWords')}
                  hint={t('brand.editor.forbiddenWordsHint')}
                >
                  {(control) => (
                    <Controller
                      control={form.control}
                      name="forbiddenWords"
                      render={({ field }) => (
                        <TagInput
                          {...control}
                          value={field.value}
                          onChange={field.onChange}
                          max={VOICE_LIMITS.forbiddenWords.items}
                          maxLength={VOICE_LIMITS.forbiddenWords.length}
                          disabled={readOnly}
                        />
                      )}
                    />
                  )}
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField id="voice-emoji" label={t('brand.editor.emojiPolicy')}>
                    {(control) => (
                      <NativeSelect {...control} {...form.register('emojiPolicy')}>
                        {EMOJI_POLICIES.map((policy) => (
                          <option key={policy} value={policy}>
                            {t(`brand.editor.emojiPolicies.${policy}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </FormField>
                  <FormField id="voice-hashtag" label={t('brand.editor.hashtagPolicy')}>
                    {(control) => (
                      <NativeSelect {...control} {...form.register('hashtagPolicy')}>
                        {HASHTAG_POLICIES.map((policy) => (
                          <option key={policy} value={policy}>
                            {t(`brand.editor.hashtagPolicies.${policy}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </FormField>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('brand.editor.examples')}</CardTitle>
                <p className="text-sm text-muted-foreground">{t('brand.editor.examplesHint')}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {examples.fields.map((example, index) => (
                  <div key={example.id} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`voice-example-${String(index)}`}>
                        {t('brand.editor.example', { number: index + 1 })}
                      </Label>
                      {readOnly ? null : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t('brand.editor.removeExample', { number: index + 1 })}
                          onClick={() => {
                            examples.remove(index);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      id={`voice-example-${String(index)}`}
                      rows={4}
                      maxLength={VOICE_LIMITS.examples.length}
                      {...form.register(exampleField(index))}
                    />
                  </div>
                ))}
                {readOnly || examples.fields.length >= VOICE_LIMITS.examples.items ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      examples.append({ text: '' });
                    }}
                  >
                    <Plus aria-hidden="true" />
                    {t('brand.editor.addExample')}
                  </Button>
                )}
              </CardContent>
            </Card>
          </fieldset>

          {readOnly ? null : (
            <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-background/95 py-3">
              {isDirty ? (
                <span className="text-sm text-muted-foreground">{t('brand.editor.unsaved')}</span>
              ) : null}
              <Button type="submit" loading={form.formState.isSubmitting}>
                {t('brand.editor.save')}
              </Button>
            </div>
          )}
        </form>

        {voice ? (
          <aside className="flex flex-col gap-6">
            {readOnly ? null : <VoiceTest ws={props.ws} voice={voice} dirty={isDirty} />}
            <VoiceVersions ws={props.ws} voice={voice} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
