'use client';

import {
  LOCALES,
  type BrandVoiceDto,
  type GeneratedVariantDto,
  type IdeaDto,
  type Locale,
  type PostDto,
  type RefineActionDto,
  type StyleDto,
} from '@smp/contracts';
import { PLATFORMS, type Platform } from '@smp/platform-rules';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Spinner,
} from '@smp/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useErrorMessage } from '@/lib/use-error-message';

import { BriefPanel } from './brief-panel';
import {
  composerReducer,
  hasUnsavedChanges,
  initialState,
  skippedResults,
  type ComposerState,
  type DraftPost,
  type DraftVariant,
} from './composer-model';
import { DiffDialog } from './diff-dialog';
import type { StreamState } from './generation-stream';
import { PlatformPreview } from './platform-preview';
import { RefineActions } from './refine-actions';
import { ConflictDialog, SaveStatus } from './save-status';
import { useComposerSaver } from './use-composer-saver';
import { useGenerationStream } from './use-generation-stream';
import { VariantEditor, VariantTabs } from './variant-editor';
import { VariantMediaStrip } from './variant-media-strip';

// The composer (guide step 2.8): brief on the left, the variants in the middle, the preview on
// the right; stacked on small screens. Changes save themselves; the AI streams into the variants
// the user has not edited, and refinements open as a diff to accept or discard.

export interface ComposerPageProps {
  ws: string;
  workspaceName: string;
  /** The language new posts start with. */
  contentLanguage: Locale;
  /** post.write; without it the post is read-only. */
  canWrite: boolean;
  /** ai.use */
  canUseAi: boolean;
  styles: StyleDto[];
  /** The brand voices that are not archived. */
  voices: BrandVoiceDto[];
  /** The saved post, or null for a new one. */
  post: PostDto | null;
  /** The idea a new post starts from. */
  idea: IdeaDto | null;
}

const DEFAULT_STYLE_KEY = 'professional';
const DEFAULT_PLATFORMS: Platform[] = ['LINKEDIN'];

interface Review {
  before: { text: string; hashtags: readonly string[] };
  after: GeneratedVariantDto;
}

/** A new post: the default style and voice, or what the idea suggests. */
function newDraft(props: ComposerPageProps): DraftPost {
  const { idea, styles } = props;
  const style =
    styles.find((candidate) => candidate.isActive && candidate.key === idea?.suggestedStyleKey) ??
    styles.find((candidate) => candidate.key === DEFAULT_STYLE_KEY) ??
    styles[0];
  const suggested = PLATFORMS.filter((platform) => idea?.suggestedPlatforms.includes(platform));
  return {
    brief: idea
      ? [idea.title, idea.angle, idea.whyNow]
          .filter((part) => part !== null && part.trim() !== '')
          .join('\n\n')
      : '',
    language: props.contentLanguage,
    styleId: style?.id ?? null,
    brandVoiceId: props.voices.find((voice) => voice.isDefault)?.id ?? null,
    ideaId: idea?.id ?? null,
    platforms: suggested.length > 0 ? suggested : DEFAULT_PLATFORMS,
  };
}

function init(props: ComposerPageProps): ComposerState {
  const state = initialState(newDraft(props));
  return props.post ? composerReducer(state, { type: 'loaded', post: props.post }) : state;
}

export function ComposerPage(props: ComposerPageProps) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const [state, dispatch] = useReducer(composerReducer, props, init);
  const readOnly = !props.canWrite;
  const canGenerate = props.canWrite && props.canUseAi;
  const saver = useComposerSaver({ ws: props.ws, state, dispatch, readOnly });
  const generation = useGenerationStream();
  const refinement = useGenerationStream();
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [review, setReview] = useState<Review | null>(null);

  // The state at the end of an AI call, which may come several renders after it started.
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  const unsaved = !readOnly && (hasUnsavedChanges(state) || saver.status.saving);
  useEffect(() => {
    if (!unsaved) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [unsaved]);

  const report = (result: StreamState) => {
    if (result.status === 'failed') {
      toast.error(errorMessage(result.code));
    } else if (result.status === 'error') {
      toast.error(errorMessage(result.error));
    }
  };

  const generate = async () => {
    setConfirmReplace(false);
    // The server generates from the saved brief, so the latest changes go first.
    const saved = await saver.flush();
    if (saved === null) {
      toast.error(t('composer.save.failed'));
      return;
    }
    if (saved.postId === null) {
      return;
    }
    dispatch({ type: 'generation-started', variantIds: saved.variants.map((variant) => variant.id) });
    const result = await generation.start(`/api/w/${props.ws}/ai/generations`, { postId: saved.postId });
    if (result.status !== 'completed') {
      report(result);
      return;
    }
    const skipped = skippedResults(latest.current, result.variants);
    dispatch({ type: 'generated', variants: result.variants });
    if (skipped > 0) {
      toast.info(t('composer.variants.notOverwritten', { count: skipped }));
    }
  };

  const requestGeneration = () => {
    if (state.post.brief.trim().length === 0) {
      toast.error(t('composer.brief.briefRequired'));
      return;
    }
    if (state.variants.some((variant) => variant.text.trim().length > 0)) {
      setConfirmReplace(true);
      return;
    }
    void generate();
  };

  const translateTo = LOCALES.find((locale) => locale !== state.post.language) ?? state.post.language;

  const refine = async (variant: DraftVariant, action: RefineActionDto, instruction?: string) => {
    const before = { text: variant.text, hashtags: variant.hashtags };
    const result = await refinement.start(`/api/w/${props.ws}/ai/refinements`, {
      variantId: variant.id,
      action,
      instruction,
      language: action === 'translate' ? translateTo : undefined,
      current: { text: variant.text, hashtags: variant.hashtags, firstComment: variant.firstComment },
    });
    if (result.status !== 'completed') {
      report(result);
      return;
    }
    const after = result.variants.find((candidate) => candidate.variantId === variant.id);
    if (after) {
      setReview({ before, after });
    }
  };

  const generating = generation.state.status === 'streaming';
  const refining = refinement.state.status === 'streaming';
  const activeIndex = state.variants.findIndex((variant) => variant.id === state.activeVariantId);
  const active = state.variants[activeIndex] ?? null;
  // While the AI writes, the variants the user leaves alone show the text as it streams in; the
  // stream sends them in the order of the targets.
  const streamingText =
    generation.state.status === 'streaming' && active && !active.edited
      ? (generation.state.partials[activeIndex]?.text ?? null)
      : null;
  const forbiddenWords =
    props.voices.find((voice) => voice.id === state.post.brandVoiceId)?.content.forbiddenWords ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">
        {state.postId ? t('composer.editTitle') : t('composer.title')}
      </h1>
      {readOnly ? <Alert>{t('composer.readOnly')}</Alert> : null}

      <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_300px]">
        <BriefPanel
          post={state.post}
          styles={props.styles}
          voices={props.voices}
          readOnly={readOnly}
          canGenerate={canGenerate}
          regenerate={state.variants.some((variant) => variant.text.trim().length > 0)}
          generating={generating}
          onChange={(patch) => {
            dispatch({ type: 'post-changed', patch });
          }}
          onGenerate={requestGeneration}
          onCancel={generation.cancel}
        />

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">{t('composer.variants.title')}</CardTitle>
            {generating ? <Spinner label={t('composer.brief.generating')} /> : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {active === null ? (
              <EmptyState title={t('composer.variants.empty')} />
            ) : (
              <>
                <VariantTabs
                  variants={state.variants}
                  activeId={active.id}
                  onSelect={(variantId) => {
                    dispatch({ type: 'activated', variantId });
                  }}
                />
                <VariantEditor
                  key={active.id}
                  variant={active}
                  streamingText={streamingText}
                  forbiddenWords={forbiddenWords}
                  readOnly={readOnly}
                  onChange={(patch) => {
                    dispatch({ type: 'variant-changed', variantId: active.id, patch });
                  }}
                />
                <VariantMediaStrip
                  key={`media-${active.id}`}
                  ws={props.ws}
                  variant={active}
                  language={state.post.language}
                  context={state.post.brief}
                  readOnly={readOnly}
                  canUseAi={canGenerate}
                  onChange={(media) => {
                    dispatch({ type: 'media-changed', variantId: active.id, media });
                  }}
                />
                {canGenerate ? (
                  <div className="border-t border-border pt-4">
                    <RefineActions
                      key={active.id}
                      variantId={active.id}
                      platform={active.platform}
                      translateTo={translateTo}
                      running={refining}
                      disabled={generating || active.text.trim().length === 0}
                      onRefine={(action, instruction) => {
                        void refine(active, action, instruction);
                      }}
                    />
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-start-2 xl:col-start-auto">
          <PlatformPreview
            key={active?.id ?? 'none'}
            platform={active?.platform ?? state.post.platforms[0] ?? null}
            text={streamingText ?? active?.text ?? ''}
            hashtags={active?.hashtags ?? []}
            media={active?.media ?? []}
            author={props.workspaceName}
          />
        </div>
      </div>

      <footer className="border-t border-border pt-4">
        <SaveStatus
          status={saver.status}
          dirty={hasUnsavedChanges(state)}
          onRetry={() => {
            void saver.flush();
          }}
        />
      </footer>

      <Dialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <DialogContent closeLabel={t('actions.close')}>
          <DialogTitle>{t('composer.replace.title')}</DialogTitle>
          <DialogDescription>{t('composer.replace.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('actions.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                void generate();
              }}
            >
              {t('composer.replace.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DiffDialog
        open={review !== null}
        before={review?.before ?? { text: '', hashtags: [] }}
        after={review?.after ?? null}
        onAccept={() => {
          if (review) {
            dispatch({ type: 'refined', result: review.after });
          }
          setReview(null);
        }}
        onDiscard={() => {
          setReview(null);
        }}
      />

      <ConflictDialog
        open={saver.status.conflict !== null}
        onReload={() => {
          void saver.resolveConflict('reload');
        }}
        onOverwrite={() => {
          void saver.resolveConflict('overwrite');
        }}
      />
    </div>
  );
}
