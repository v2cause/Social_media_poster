'use client';

import { ApiError, postsCreate, postsGet, postsUpdate, variantsUpdate } from '@smp/api-client';
import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react';

import {
  composerReducer,
  hasUnsavedChanges,
  isPostDirty,
  isVariantDirty,
  readyToCreate,
  type ComposerAction,
  type ComposerState,
} from './composer-model';

// Auto-save of the composer (guide step 2.8): a short pause after the last change saves the post
// and every changed variant, one request after the other, each with the version it read. A 409
// stops saving until the user chooses to reload or to overwrite.

const DELAY_MS = 800;

export type Conflict = { kind: 'post' } | { kind: 'variant'; variantId: string };

export interface SaverStatus {
  saving: boolean;
  savedAt: Date | null;
  failed: boolean;
  conflict: Conflict | null;
}

export function useComposerSaver(options: {
  ws: string;
  state: ComposerState;
  dispatch: Dispatch<ComposerAction>;
  readOnly: boolean;
}): {
  status: SaverStatus;
  /** Saves now; the saved state, or null when saving failed or waits for a conflict. */
  flush: () => Promise<ComposerState | null>;
  resolveConflict: (choice: 'reload' | 'overwrite') => Promise<void>;
} {
  const { ws, state, dispatch, readOnly } = options;
  const [status, setStatus] = useState<SaverStatus>({
    saving: false,
    savedAt: null,
    failed: false,
    conflict: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const conflictRef = useRef<Conflict | null>(null);
  const mountedRef = useRef(true);

  // Applies an action to the ref at once as well: the next queued save may run before React has
  // rendered, and must see the versions this save received.
  const apply = useCallback(
    (action: ComposerAction) => {
      stateRef.current = composerReducer(stateRef.current, action);
      dispatch(action);
    },
    [dispatch],
  );

  const saveOnce = useCallback(async (): Promise<ComposerState | null> => {
    if (readOnly) {
      return stateRef.current;
    }
    if (conflictRef.current) {
      return null;
    }
    const current = stateRef.current;
    const needsPost = current.postId === null ? readyToCreate(current) : isPostDirty(current);
    const dirtyVariants = current.variants.filter(isVariantDirty);
    if (!needsPost && dirtyVariants.length === 0) {
      return current;
    }
    setStatus((previous) => ({ ...previous, saving: true }));
    // Which save a failure belongs to, for the conflict dialog.
    let attempt: Conflict = { kind: 'post' };
    try {
      const postId = current.postId;
      if (needsPost) {
        const { revision, post } = current;
        const fields = {
          brief: post.brief,
          language: post.language,
          styleId: post.styleId,
          brandVoiceId: post.brandVoiceId,
          platforms: post.platforms,
        };
        const saved =
          postId === null
            ? await postsCreate(ws, { ...fields, ideaId: post.ideaId })
            : await postsUpdate(ws, postId, { ...fields, version: current.version });
        apply({ type: 'post-saved', post: saved, revision });
        if (postId === null && mountedRef.current) {
          // The address of the saved post, without a navigation that would reset the editor.
          window.history.replaceState(null, '', `/w/${ws}/posts/${saved.id}`);
        }
      }
      for (const variant of dirtyVariants) {
        attempt = { kind: 'variant', variantId: variant.id };
        const saved = await variantsUpdate(ws, variant.id, {
          version: variant.version,
          text: variant.text,
          hashtags: variant.hashtags,
          firstComment: variant.firstComment,
          aiWarnings: variant.aiWarnings,
        });
        apply({ type: 'variant-saved', variant: saved, revision: variant.revision });
      }
      setStatus({ saving: false, savedAt: new Date(), failed: false, conflict: null });
      return stateRef.current;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        conflictRef.current = attempt;
        setStatus((previous) => ({ ...previous, saving: false, conflict: attempt }));
      } else {
        setStatus((previous) => ({ ...previous, saving: false, failed: true }));
      }
      return null;
    }
  }, [apply, readOnly, ws]);

  /** Runs the saves one after the other, never two at the same time. */
  const enqueue = useCallback((): Promise<ComposerState | null> => {
    const next = queueRef.current.then(saveOnce, saveOnce);
    queueRef.current = next;
    return next;
  }, [saveOnce]);

  const variantRevisions = state.variants
    .map((variant) => `${variant.id}:${String(variant.revision)}`)
    .join(',');
  useEffect(() => {
    if (readOnly) {
      return;
    }
    const timer = setTimeout(() => {
      if (hasUnsavedChanges(stateRef.current)) {
        void enqueue();
      }
    }, DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state.revision, variantRevisions, enqueue, readOnly]);

  // Leaving the composer inside the app saves what the pause before the auto-save would have.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!readOnly && hasUnsavedChanges(stateRef.current)) {
        void enqueue();
      }
    };
  }, [enqueue, readOnly]);

  const flush = useCallback(() => enqueue(), [enqueue]);

  const resolveConflict = useCallback(
    async (choice: 'reload' | 'overwrite') => {
      const conflict = conflictRef.current;
      const postId = stateRef.current.postId;
      if (!conflict || !postId) {
        return;
      }
      const fresh = await postsGet(ws, postId);
      conflictRef.current = null;
      setStatus((previous) => ({ ...previous, conflict: null }));
      if (choice === 'reload') {
        apply({ type: 'loaded', post: fresh });
        return;
      }
      // Overwrite: take the current versions and save the local state on top of them.
      apply({ type: 'post-version', version: fresh.version });
      for (const variant of fresh.variants) {
        apply({ type: 'variant-version', variantId: variant.id, version: variant.version });
      }
      await enqueue();
    },
    [apply, enqueue, ws],
  );

  return { status, flush, resolveConflict };
}
