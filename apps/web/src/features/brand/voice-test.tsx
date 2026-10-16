'use client';

import { useBrandVoicesTest } from '@smp/api-client';
import { BRIEF_MAX_LENGTH, type BrandVoiceDto } from '@smp/contracts';
import { composePostText } from '@smp/platform-rules';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Textarea,
} from '@smp/ui';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

// "Stimme testen" (guide step 2.9): the AI writes a sample post with the saved version of the
// voice, optionally about a topic, and the result shows the forbidden words it still contains.

export function VoiceTest(props: { ws: string; voice: BrandVoiceDto; dirty: boolean }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const test = useBrandVoicesTest();
  const [brief, setBrief] = useState('');
  const result = test.data?.variant;
  const blocked = props.dirty || props.voice.archived;

  const run = async () => {
    try {
      const topic = brief.trim();
      await test.mutateAsync({
        ws: props.ws,
        brandVoiceId: props.voice.id,
        data: topic.length > 0 ? { brief: topic } : {},
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('brand.test.title')}</CardTitle>
        <CardDescription>{t('brand.test.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="voice-test-brief">{t('brand.test.brief')}</Label>
          <Textarea
            id="voice-test-brief"
            rows={3}
            value={brief}
            maxLength={BRIEF_MAX_LENGTH}
            placeholder={t('brand.test.briefPlaceholder')}
            onChange={(event) => {
              setBrief(event.target.value);
            }}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          loading={test.isPending}
          disabled={blocked}
          onClick={() => void run()}
        >
          <Sparkles aria-hidden="true" />
          {test.isPending ? t('brand.test.running') : t('brand.test.run')}
        </Button>
        {props.voice.archived ? (
          <p className="text-xs text-muted-foreground">{t('brand.test.archived')}</p>
        ) : props.dirty ? (
          <p className="text-xs text-muted-foreground">{t('brand.test.saveFirst')}</p>
        ) : null}
        {result ? (
          <article
            aria-label={t('brand.test.result', { platform: t(`platforms.${result.platform}`) })}
            className="flex flex-col gap-2 rounded-md border border-border bg-background p-3"
            data-testid="voice-test-result"
          >
            <h3 className="text-sm font-medium">
              {t('brand.test.result', { platform: t(`platforms.${result.platform}`) })}
            </h3>
            <p className="whitespace-pre-wrap break-words text-sm">
              {composePostText(result.text, result.hashtags)}
            </p>
            {result.forbiddenWords.length > 0 ? (
              <Badge variant="warning" className="gap-1 self-start">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {t('brand.test.forbidden', { words: result.forbiddenWords.join(', ') })}
              </Badge>
            ) : null}
            {result.warnings.map((warning) => (
              <Badge key={warning} variant="warning" className="gap-1 self-start">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {warning}
              </Badge>
            ))}
          </article>
        ) : null}
      </CardContent>
    </Card>
  );
}
