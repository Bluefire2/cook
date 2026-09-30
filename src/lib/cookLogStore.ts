import { useMemo, useSyncExternalStore } from 'react';
import { t } from '../i18n';
import {
  dropPhoto,
  getCookLog,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  isSharedRecipe,
  listCookLogs,
  markPhotoRemote,
  removeCookLogLocal,
  subscribe,
  upsertCookLog,
} from './libraryMemory';
import { withLocalWrite } from './localWrite';
import { postPhoto, pushOps, type RemoteResult } from './remote';
import {
  appendLessonToNotes,
  compactCookLog,
  isUsableCookLog,
  lessonInNotes,
} from './cookLogShape';
import { recipeStore } from './recipeStore';
import type { CookLog } from './types';
import type { PushOp } from './pushOps';

export type CookLogInput = Omit<CookLog, 'id' | 'createdAt' | 'updatedAt'>;

function pushError(result: RemoteResult | 'unavailable', fallback: string): Error {
  return new Error(result === 'signedOut' ? t('error.sessionExpired') : fallback);
}

async function uploadCookLogPhotos(log: CookLog): Promise<void> {
  for (const photoId of log.photoIds ?? []) {
    const blob = getPendingBlob(photoId);
    if (!blob) {
      continue;
    }
    const result = await postPhoto(photoId, log.recipeId, log.updatedAt, blob);
    if (result !== 'ok') {
      throw pushError(result, t('error.photoSave'));
    }
    markPhotoRemote(photoId);
  }
}

async function deleteRemovedPhotos(previous: CookLog | undefined, next: CookLog): Promise<void> {
  const keep = new Set(next.photoIds ?? []);
  const removed = (previous?.photoIds ?? []).filter((photoId) => !keep.has(photoId));
  if (removed.length === 0) {
    return;
  }
  const at = Date.now();
  const result = await pushOps(
    removed.map((id) => ({ kind: 'photo.delete' as const, payload: { id, updatedAt: at } })),
  );
  if (result === 'ok') {
    for (const photoId of removed) {
      dropPhoto(photoId);
    }
  }
}

/**
 * Photos go up before the put so another device never pulls an entry whose
 * bytes do not exist yet. The server answers a put for a deleted recipe with
 * `recipe-deleted`, which `pushOps` reports as ok, so the parent is checked
 * here first.
 */
async function putCookLog(next: CookLog, previous: CookLog | undefined): Promise<void> {
  if (!getRecipe(next.recipeId)) {
    throw new Error(t('error.recipeGone'));
  }
  if (isSharedRecipe(next.recipeId)) {
    throw new Error(t('error.cookLogSharedRecipe'));
  }
  if (!isUsableCookLog(next)) {
    throw new Error(t('error.cookLogSave'));
  }
  await withLocalWrite(async () => {
    upsertCookLog(next);
    try {
      await uploadCookLogPhotos(next);
      const result = await pushOps([{ kind: 'cookLog.put', payload: next }]);
      if (result !== 'ok') {
        throw pushError(result, t('error.cookLogSave'));
      }
    } catch (err) {
      if (previous) {
        upsertCookLog(previous);
      } else {
        removeCookLogLocal(next.id);
      }
      throw err;
    }
    await deleteRemovedPhotos(previous, next);
    return { value: undefined, reconcile: true };
  });
}

export const cookLogStore = {
  /** `photoIds` must already be in `photoStore`; encoding is the caller's job. */
  async create(input: CookLogInput): Promise<CookLog> {
    const now = Date.now();
    const log = compactCookLog({
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    await putCookLog(log, undefined);
    return log;
  },

  async save(log: CookLog): Promise<void> {
    const previous = getCookLog(log.id);
    await putCookLog(compactCookLog({ ...log, updatedAt: Date.now() }), previous);
  },

  /** One batch, entry first: a partial batch leaves only photos, which the recipe cascade still finds. */
  async remove(id: string): Promise<void> {
    const previous = getCookLog(id);
    const at = Date.now();
    const photoIds = previous?.photoIds ?? [];
    await withLocalWrite(async () => {
      removeCookLogLocal(id);
      const ops: PushOp[] = [{ kind: 'cookLog.delete', payload: { id, updatedAt: at } }];
      for (const photoId of photoIds) {
        ops.push({ kind: 'photo.delete', payload: { id: photoId, updatedAt: at } });
      }
      const result = await pushOps(ops);
      if (result !== 'ok') {
        if (previous) {
          upsertCookLog(previous);
        }
        throw pushError(result, t('error.cookLogDelete'));
      }
      for (const photoId of photoIds) {
        dropPhoto(photoId);
      }
      return { value: undefined, reconcile: true };
    });
  },

  /** Reads the latest recipe so a concurrent edit is not overwritten with a stale copy. */
  async promoteLesson(recipeId: string, log: CookLog): Promise<void> {
    const recipe = getRecipe(recipeId);
    if (!recipe) {
      throw new Error(t('error.recipeGone'));
    }
    if (lessonInNotes(recipe.notes, log.lessons)) {
      return;
    }
    const notes = appendLessonToNotes(recipe.notes, log.lessons);
    if (notes === recipe.notes) {
      return;
    }
    await recipeStore.save({ ...recipe, notes });
  },
};

/** Reactive cook logs, newest cook first; all entries when `recipeId` is omitted. `undefined` while loading. */
export function useCookLogs(recipeId?: string): CookLog[] | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    if (!snap.loaded) {
      return undefined;
    }
    return listCookLogs(recipeId);
  }, [snap, recipeId]);
}

/** Reactive single cook log. `undefined` while loading, `null` if not found. */
export function useCookLog(id: string | undefined): CookLog | null | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  if (!snap.loaded) {
    return undefined;
  }
  if (!id) {
    return null;
  }
  return snap.cookLogs.get(id) ?? null;
}
