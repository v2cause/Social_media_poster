'use client';

import { ApiError } from '@smp/api-client';
import { ERROR_CODES, type ErrorCode, type MediaAssetDto } from '@smp/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { StorageUploadError, checkFile, uploadMedia } from './upload';
import { busy, queuedItem, startable, updated, type UploadItem } from './upload-queue';

// The uploads of a page (guide step 3.6): files are checked in the browser first, then uploaded
// three at a time. Leaving the page cancels the uploads still running.

const isErrorCode = (code: string): code is ErrorCode => (ERROR_CODES as readonly string[]).includes(code);

function errorOf(error: unknown): UploadItem['error'] {
  if (error instanceof ApiError && isErrorCode(error.code)) {
    return error.code;
  }
  return error instanceof StorageUploadError ? 'storage' : 'unknown';
}

export function useUploads(
  ws: string,
  onUploaded?: (asset: MediaAssetDto) => void,
): {
  items: UploadItem[];
  busy: boolean;
  add: (files: Iterable<File>) => void;
  dismiss: (id: string) => void;
} {
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<string, File>());
  const started = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;

  const add = useCallback((list: Iterable<File>) => {
    const added: UploadItem[] = [];
    for (const file of list) {
      const id = crypto.randomUUID();
      const problem = checkFile(file);
      if (problem) {
        added.push({ ...queuedItem(id, file), status: 'failed', error: problem });
      } else {
        files.current.set(id, file);
        added.push(queuedItem(id, file));
      }
    }
    setItems((previous) => [...previous, ...added]);
  }, []);

  useEffect(() => {
    for (const item of startable(items)) {
      const file = files.current.get(item.id);
      // Effects may run twice for the same state; every upload starts once.
      if (!file || started.current.has(item.id)) {
        continue;
      }
      started.current.add(item.id);
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      setItems((previous) => updated(previous, item.id, { status: 'uploading' }));
      uploadMedia(
        ws,
        file,
        (progress) => {
          setItems((previous) => updated(previous, item.id, { progress }));
        },
        controller.signal,
      )
        .then((asset) => {
          setItems((previous) => updated(previous, item.id, { status: 'done', progress: 1, asset }));
          uploaded.current?.(asset);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setItems((previous) => updated(previous, item.id, { status: 'failed', error: errorOf(error) }));
          }
        })
        .finally(() => {
          files.current.delete(item.id);
          controllers.current.delete(item.id);
        });
    }
  }, [items, ws]);

  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) {
        controller.abort();
      }
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  return { items, busy: busy(items), add, dismiss };
}
