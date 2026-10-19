'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMembershipsCreateOrganization } from '@smp/api-client';
import {
  createOrganizationSchema,
  DEFAULT_TIMEZONE,
  LOCALES,
  type CreateOrganizationRequest,
} from '@smp/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  NativeSelect,
  Steps,
  Textarea,
} from '@smp/ui';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useErrorMessage } from '@/lib/use-error-message';
import { useFieldError } from '@/lib/use-field-error';

type FormValues = z.input<typeof createOrganizationSchema>;

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [DEFAULT_TIMEZONE, 'UTC'];
  }
}

/** Three steps with progress (guide step 1.9): organization, workspace profile, done. */
export function OnboardingWizard() {
  const t = useTranslations('onboarding');
  const tLanguages = useTranslations('languages');
  const locale = useLocale();
  const fieldError = useFieldError();
  const errorMessage = useErrorMessage();
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);
  const zones = useMemo(() => timeZones(), []);
  const createOrganization = useMembershipsCreateOrganization();

  const form = useForm<FormValues, unknown, CreateOrganizationRequest>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      name: '',
      workspace: {
        name: '',
        timezone: zones.includes(DEFAULT_TIMEZONE) ? DEFAULT_TIMEZONE : 'UTC',
        contentLanguage: locale === 'en' ? 'en' : 'de',
        industry: '',
        targetAudience: '',
        goals: '',
        contentPillars: [],
      },
    },
  });
  const errors = form.formState.errors;

  const next = async () => {
    if (await form.trigger('name')) {
      setStep(1);
    }
  };

  const submit = form.handleSubmit(async (values) => {
    const result = await createOrganization.mutateAsync({ data: values });
    setCreated({ slug: result.workspaceSlug, name: values.workspace.name });
    setStep(2);
  });

  const steps = [t('steps.organization'), t('steps.workspace'), t('steps.done')];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      <Steps steps={steps} current={step} label={t('progress')} />

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('organization.title')}</CardTitle>
            <CardDescription>{t('organization.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void next();
              }}
              noValidate
            >
              <FormField
                id="organization-name"
                label={t('organization.name')}
                error={fieldError(errors.name, { minimum: 2, maximum: 100 })}
              >
                {(control) => (
                  <Input
                    {...control}
                    {...form.register('name')}
                    placeholder={t('organization.namePlaceholder')}
                    autoFocus
                  />
                )}
              </FormField>
              <Button type="submit" className="self-end">
                {t('steps.workspace')}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('workspace.title')}</CardTitle>
            <CardDescription>{t('workspace.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              className="flex flex-col gap-4"
              onSubmit={(event) => void submit(event)}
              noValidate
            >
              {createOrganization.error ? (
                <Alert variant="destructive" title={errorMessage(createOrganization.error)} />
              ) : null}
              <FormField
                id="workspace-name"
                label={t('workspace.name')}
                error={fieldError(errors.workspace?.name, { minimum: 2, maximum: 80 })}
              >
                {(control) => <Input {...control} {...form.register('workspace.name')} autoFocus />}
              </FormField>
              <FormField
                id="workspace-industry"
                label={`${t('workspace.industry')} (${t('workspace.optional')})`}
                error={fieldError(errors.workspace?.industry, { maximum: 100 })}
              >
                {(control) => <Input {...control} {...form.register('workspace.industry')} />}
              </FormField>
              <FormField
                id="workspace-audience"
                label={`${t('workspace.targetAudience')} (${t('workspace.optional')})`}
                error={fieldError(errors.workspace?.targetAudience, { maximum: 500 })}
              >
                {(control) => <Textarea {...control} {...form.register('workspace.targetAudience')} />}
              </FormField>
              <FormField
                id="workspace-goals"
                label={`${t('workspace.goals')} (${t('workspace.optional')})`}
                error={fieldError(errors.workspace?.goals, { maximum: 500 })}
              >
                {(control) => <Textarea {...control} {...form.register('workspace.goals')} />}
              </FormField>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  id="workspace-language"
                  label={t('workspace.contentLanguage')}
                  error={fieldError(errors.workspace?.contentLanguage)}
                >
                  {(control) => (
                    <NativeSelect {...control} {...form.register('workspace.contentLanguage')}>
                      {LOCALES.map((value) => (
                        <option key={value} value={value}>
                          {tLanguages(value)}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
                <FormField
                  id="workspace-timezone"
                  label={t('workspace.timezone')}
                  error={fieldError(errors.workspace?.timezone)}
                >
                  {(control) => (
                    <NativeSelect {...control} {...form.register('workspace.timezone')}>
                      {zones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
              </div>
              <div className="flex justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setStep(0);
                  }}
                >
                  {t('steps.organization')}
                </Button>
                <Button type="submit" loading={createOrganization.isPending}>
                  {t('workspace.submit')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 && created ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('done.title')}</CardTitle>
            <CardDescription>{t('done.description', { workspace: created.name })}</CardDescription>
          </CardHeader>
          <CardContent>
            <Alert title={t('done.accountsTitle')}>{t('done.accountsHint')}</Alert>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/w/${created.slug}/dashboard`}>{t('done.toDashboard')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/w/${created.slug}/accounts`}>{t('done.toAccounts')}</Link>
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
