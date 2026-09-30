import { useMemo, useSyncExternalStore } from 'react';
import { t } from '../i18n';
import {
  addPendingBlob,
  beginLocalWrite,
  captureSnapshot,
  dropPhoto,
  endLocalWrite,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  libraryEpoch,
  listRecipes,
  markPhotoRemote,
  photoOwnerSub,
  removeRecipeLocal,
  restoreSnapshot,
  subscribe,
  upsertRecipe,
  getCollection,
  getRecipeOrigin,
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  recipeAccess,
  upsertCollection,
  type LibraryAccess,
} from './libraryMemory';
import { fetchPhotoBlobOutcome, postPhoto, pushOps } from './remote';
import { photoStore } from './photoStore';
import { localWriteOverlapsPull, pullAfterLocalWrite } from './syncEngine';
import { compactRecipe } from './compactRecipe';
import { compactCollection } from './compactCollection';
import { wouldExceedRecipeIdCap } from './collectionMembership';
import { recipePhotoIds } from './recipePhotos';
import type { Recipe, RecipeDraft } from './types';
import type { PushOp } from './pushOps';

export { compactRecipe };

/**
 * A 401/403 from the server. The message is the usual sign-in prompt; the type
 * lets a rollback tell sign-out apart without reading the text.
 */
class SessionExpiredError extends Error {
  constructor() {
    super(t('error.sessionExpired'));
  }
}

/**
 * A create that did not stick. The message is the error to show. Its staged
 * photo bytes are kept for a retry, but when the server may still hold the
 * failed recipe they move to new ids: `photoIdRemap` maps each old id to its
 * new one, and a retry must use the new ids (`remapPhotoIds`). Empty when
 * the old ids are safe to reuse.
 */
export class CreateRollbackError extends Error {
  readonly photoIdRemap: ReadonlyMap<string, string>;

  constructor(cause: unknown, photoIdRemap: ReadonlyMap<string, string>) {
    super(cause instanceof Error ? cause.message : t('error.recipeSave'), { cause });
    this.photoIdRemap = photoIdRemap;
  }
}

/**
 * Uploads a staged blob. Returns the id when this call is what made it
 * remote, so a failed save can tombstone that orphan. An id that was already
 * remote is uploaded again if its bytes are still staged, but it is not
 * returned: deleting it would drop a photo the live recipe still lists.
 */
async function uploadPhotoIfNeeded(
  photoId: string | undefined,
  recipeId: string,
  updatedAt: number,
): Promise<string | undefined> {
  if (photoId === undefined) {
    return undefined;
  }
  const blob = getPendingBlob(photoId);
  if (!blob) {
    return undefined;
  }
  const alreadyRemote = getSnapshot().remotePhotoIds.has(photoId);
  const result = await postPhoto(photoId, recipeId, updatedAt, blob);
  if (result !== 'ok') {
    throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.photoSave'));
  }
  markPhotoRemote(photoId);
  return alreadyRemote ? undefined : photoId;
}

type ParentPhotoSlot = { kind: 'cover' | 'gallery'; id: string };

function parentPhotoSlots(parent: Recipe): ParentPhotoSlot[] {
  const slots: ParentPhotoSlot[] = [];
  if (parent.photoId !== undefined) {
    slots.push({ kind: 'cover', id: parent.photoId });
  }
  for (const id of parent.galleryPhotoIds ?? []) {
    slots.push({ kind: 'gallery', id });
  }
  return slots;
}

async function loadParentPhoto(id: string): Promise<Blob | 'missing' | 'unavailable' | 'signedOut'> {
  const pending = getPendingBlob(id);
  if (pending) {
    return pending;
  }
  return fetchPhotoBlobOutcome(id, photoOwnerSub(id));
}

/**
 * Cover and gallery copied onto new ids owned by the saver. A 404 is skipped.
 * A temporary fetch failure or a signed-out session aborts before any copy is
 * minted, so the save can be retried with the original photos still in place.
 */
async function copyParentPhotos(parent: Recipe): Promise<{
  photoId: string | undefined;
  galleryPhotoIds: string[] | undefined;
}> {
  const slots = parentPhotoSlots(parent);
  const loaded = await Promise.all(slots.map((slot) => loadParentPhoto(slot.id)));
  if (loaded.some((item) => item === 'signedOut')) {
    throw new Error(t('error.sessionExpired'));
  }
  if (loaded.some((item) => item === 'unavailable')) {
    throw new Error(t('error.photosCopy'));
  }

  let photoId: string | undefined;
  const galleryPhotoIds: string[] = [];
  for (let index = 0; index < slots.length; index += 1) {
    const blob = loaded[index];
    if (!(blob instanceof Blob)) {
      continue;
    }
    const nextId = await photoStore.add(blob);
    if (slots[index]?.kind === 'cover') {
      photoId = nextId;
    } else {
      galleryPhotoIds.push(nextId);
    }
  }
  return {
    photoId,
    galleryPhotoIds: galleryPhotoIds.length > 0 ? galleryPhotoIds : undefined,
  };
}

/** `uploaded` collects ids this attempt made remote, including when a later upload throws. */
async function uploadRecipePhotos(recipe: Recipe, uploaded: string[] = []): Promise<void> {
  for (const photoId of recipePhotoIds(recipe)) {
    const id = await uploadPhotoIfNeeded(photoId, recipe.id, recipe.updatedAt);
    if (id !== undefined) {
      uploaded.push(id);
    }
  }
}

/** Tombstone one photo. Local bytes drop only when the server accepts it. */
async function deletePhoto(photoId: string): Promise<Awaited<ReturnType<typeof pushOps>>> {
  const at = Date.now();
  const result = await pushOps([
    { kind: 'photo.delete', payload: { id: photoId, updatedAt: at } },
  ]);
  if (result === 'ok') {
    dropPhoto(photoId);
  }
  return result;
}

async function deleteRemovedPhotos(
  previous: Recipe | undefined,
  next: Recipe,
): Promise<void> {
  const keep = new Set(recipePhotoIds(next));
  for (const photoId of previous ? recipePhotoIds(previous) : []) {
    if (keep.has(photoId)) {
      continue;
    }
    await deletePhoto(photoId);
  }
}

/**
 * Photos this save uploaded and then failed to attach. Best effort: a failed
 * delete must not replace the save error, and a 401 stops the rest.
 */
async function discardOrphanUploads(photoIds: readonly string[]): Promise<void> {
  for (const photoId of photoIds) {
    try {
      const result = await deletePhoto(photoId);
      if (result === 'signedOut') {
        return;
      }
    } catch {
      // Best effort; the caller surfaces the original error.
    }
  }
}

function samePhotoIds(a: Recipe, b: Recipe): boolean {
  const left = recipePhotoIds(a);
  const right = recipePhotoIds(b);
  return (
    a.photoId === b.photoId &&
    left.length === right.length &&
    left.every((id, i) => id === right[i])
  );
}

/**
 * An editor's save of someone else's recipe. Text only: the server refuses a
 * photo change from anyone but the owner, so it is refused here before any
 * upload, and nothing is uploaded or deleted. The row keeps its shared
 * origin; the next pull brings back whatever the owner's tree holds.
 */
async function saveShared(recipe: Recipe): Promise<void> {
  const previous = getRecipe(recipe.id);
  const origin = getRecipeOrigin(recipe.id);
  if (!previous || origin?.kind !== 'shared') {
    throw new Error(t('common.recipeNotFound'));
  }
  const next = compactRecipe({
    ...recipe,
    createdAt: previous.createdAt,
    updatedAt: Date.now(),
  });
  if (!samePhotoIds(previous, next)) {
    throw new Error(t('error.sharedPhotos'));
  }
  upsertRecipe(next, origin);
  try {
    const result = await pushOps([{ kind: 'recipe.put', payload: next, shared: true }]);
    if (result !== 'ok') {
      throw new Error(result === 'signedOut' ? t('error.sessionExpired') : t('error.recipeSave'));
    }
  } catch (err) {
    upsertRecipe(previous, origin);
    throw err;
  }
}

/** Bytes a new recipe's photos are waiting to upload, captured before any upload. */
function stagedBlobs(recipe: Recipe): Map<string, Blob> {
  const staged = new Map<string, Blob>();
  for (const photoId of recipePhotoIds(recipe)) {
    const blob = getPendingBlob(photoId);
    if (blob) {
      staged.set(photoId, blob);
    }
  }
  return staged;
}

/**
 * Puts a failed create's staged bytes back as pending, including any this
 * attempt uploaded, so a retry uploads them again. Same ids only when the
 * server is known not to hold the failed recipe; otherwise that recipe may
 * still list the ids, and deleting it later force-tombstones every photo it
 * lists, including ones a retry shared with it. `remove` of a saved recipe
 * still drops its bytes.
 */
function restageBlobs(
  staged: ReadonlyMap<string, Blob>,
  sameIds: boolean,
): ReadonlyMap<string, string> {
  const remap = new Map<string, string>();
  for (const [photoId, blob] of staged) {
    const nextId = sameIds ? photoId : crypto.randomUUID();
    addPendingBlob(nextId, blob);
    if (nextId !== photoId) {
      remap.set(photoId, nextId);
    }
  }
  return remap;
}

/**
 * Undoes a create that may have reached the server: its recipe put, or a
 * photo upload after it, failed. Whether the put landed is unknowable (a
 * dropped response, or a rejected collection op in the same batch), so this
 * always pushes `recipe.delete` plus the collection scrub; for an id that
 * never landed it writes an unused tombstone. The server's delete cascade
 * tombstones any photo already stored under the recipe. Best effort, never
 * retried. Returns the photo id remap for `CreateRollbackError`, or
 * `'signedOut'` when the delete met a 401 (the library is already cleared).
 */
async function discardCreatedRecipe(
  id: string,
  staged: ReadonlyMap<string, Blob>,
): Promise<ReadonlyMap<string, string> | 'signedOut'> {
  const at = Date.now();
  // Same membership scrub as `remove`: a dead id still counts against the cap.
  const scrubbed = listCollections()
    .filter((c) => c.recipeIds.includes(id))
    .map((c) =>
      compactCollection({
        ...c,
        recipeIds: c.recipeIds.filter((recipeId) => recipeId !== id),
        updatedAt: at,
      }),
    );
  // A pull that read the live row before the delete landed must not paint it
  // back; hold the library as `remove` does.
  const writeEpoch = beginLocalWrite();
  removeRecipeLocal(id);
  for (const collection of scrubbed) {
    upsertCollection(collection);
  }
  const ops: PushOp[] = [{ kind: 'recipe.delete', payload: { id, updatedAt: at } }];
  for (const collection of scrubbed) {
    ops.push({ kind: 'collection.put', payload: collection });
  }
  let result: Awaited<ReturnType<typeof pushOps>> = 'error';
  try {
    result = await pushOps(ops);
  } catch {
    // Best effort; the caller surfaces the original error.
  } finally {
    endLocalWrite();
  }
  if (result === 'signedOut') {
    // The 401 cleared the library; keep nothing.
    return 'signedOut';
  }
  // Anything but 'ok' leaves the failed recipe possibly live on the server.
  const remap = restageBlobs(staged, result === 'ok');
  if (result === 'ok' && localWriteOverlapsPull(writeEpoch)) {
    try {
      await pullAfterLocalWrite(writeEpoch);
    } catch {
      // The next pull reconciles.
    }
  }
  return remap;
}

export const recipeStore = {
  list(): Recipe[] {
    return listRecipes();
  },

  get(id: string): Recipe | undefined {
    return getRecipe(id);
  },

  /** True for a recipe that arrived through an incoming share. */
  isShared(id: string): boolean {
    return isSharedRecipe(id);
  },

  /** `editor` when a shared recipe may be edited here (text only, not photos). */
  access(id: string): LibraryAccess | undefined {
    return recipeAccess(id);
  },

  async save(recipe: Recipe): Promise<void> {
    if (isSharedRecipe(recipe.id)) {
      if (recipeAccess(recipe.id) !== 'editor') {
        throw new Error(t('error.sharedViewOnly'));
      }
      return saveShared(recipe);
    }
    const previous = getRecipe(recipe.id);
    const next = compactRecipe({ ...recipe, updatedAt: Date.now() });
    upsertRecipe(next);
    const uploaded: string[] = [];
    let putLanded = false;
    try {
      await uploadRecipePhotos(next, uploaded);
      const result = await pushOps([{ kind: 'recipe.put', payload: next }]);
      if (result !== 'ok') {
        throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.recipeSave'));
      }
      putLanded = true;
      await deleteRemovedPhotos(previous, next);
    } catch (err) {
      if (previous) {
        upsertRecipe(previous);
      } else {
        removeRecipeLocal(next.id);
      }
      // The put never landed, so these ids are finalized and unreferenced.
      // A signed-out session cannot authorize the tombstone.
      if (!putLanded && !(err instanceof SessionExpiredError)) {
        await discardOrphanUploads(uploaded);
      }
      throw err;
    }
  },

  /**
   * Merges a draft into the recipe with this id. Every field is named rather
   * than spread because drafts come from the `update_recipe` tool, whose schema
   * cannot express `sourceUrl`, `photoId`, `galleryPhotoIds`, or `lang` — a
   * spread would blank them. `lang` is carried from the existing recipe,
   * like `sourceUrl`. On a shared recipe the draft never supplies photos.
   * The draft is an edit of the stored recipe, including while a translation
   * is on screen.
   */
  async applyDraft(id: string, draft: RecipeDraft): Promise<void> {
    const existing = getRecipe(id);
    if (!existing) throw new Error(`No recipe with id ${id}.`);
    const shared = isSharedRecipe(id);
    const photoId = shared ? existing.photoId : (draft.photoId ?? existing.photoId);
    const galleryPhotoIds = shared
      ? existing.galleryPhotoIds
      : (draft.galleryPhotoIds ?? existing.galleryPhotoIds);
    await recipeStore.save({
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      title: draft.title,
      description: draft.description,
      servings: draft.servings,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      ingredientSections: draft.ingredientSections,
      steps: draft.steps,
      tags: draft.tags,
      notes: draft.notes,
      sourceUrl: draft.sourceUrl ?? existing.sourceUrl,
      lang: draft.lang ?? existing.lang,
      photoId,
      galleryPhotoIds,
    });
  },

  /**
   * A new recipe from an Ask proposal. Photos come from `parent`, copied onto
   * new ids. Fields on the draft never supply a photo. `lang` comes from
   * `parent` too: the proposal never carries it, including when `parent` is
   * a shared recipe.
   */
  async createFromAsk(parent: Recipe, draft: RecipeDraft): Promise<Recipe> {
    const copied = await copyParentPhotos(parent);
    try {
      return await recipeStore.create({
        ...draft,
        lang: parent.lang,
        photoId: copied.photoId,
        galleryPhotoIds: copied.galleryPhotoIds,
      });
    } catch (err) {
      // A retry copies onto fresh ids, so these copies would never upload.
      for (const photoId of [copied.photoId, ...(copied.galleryPhotoIds ?? [])]) {
        if (photoId !== undefined) {
          dropPhoto(photoId);
        }
      }
      if (err instanceof CreateRollbackError) {
        for (const photoId of err.photoIdRemap.values()) {
          dropPhoto(photoId);
        }
      }
      throw err;
    }
  },

  async create(
    data: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>,
    opts?: { collectionId?: string },
  ): Promise<Recipe> {
    const now = Date.now();
    const recipe = compactRecipe({
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    const collectionId = opts?.collectionId;
    const previousCollection =
      collectionId !== undefined ? getCollection(collectionId) : undefined;
    let nextCollection = previousCollection;
    if (collectionId !== undefined) {
      if (!previousCollection || isSharedCollection(collectionId)) {
        throw new Error(t('error.collectionNotFound'));
      }
      if (wouldExceedRecipeIdCap([...previousCollection.recipeIds, recipe.id])) {
        throw new Error(t('error.collectionFull'));
      }
      nextCollection = compactCollection({
        ...previousCollection,
        recipeIds: [...previousCollection.recipeIds, recipe.id],
        updatedAt: now,
      });
    }
    const staged = stagedBlobs(recipe);
    if (staged.size !== recipePhotoIds(recipe).length) {
      // This call uploads a new recipe's photos. An id with no bytes here
      // would save a recipe pointing at a photo that never exists.
      throw new Error(t('error.photoSave'));
    }
    upsertRecipe(recipe);
    if (nextCollection) {
      upsertCollection(nextCollection);
    }
    // The server stores a photo only under a live recipe, so the recipe row
    // goes first and the photos follow.
    try {
      const ops: PushOp[] = [{ kind: 'recipe.put', payload: recipe }];
      if (nextCollection) {
        ops.push({ kind: 'collection.put', payload: nextCollection });
      }
      const result = await pushOps(ops);
      if (result !== 'ok') {
        throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.recipeSave'));
      }
      await uploadRecipePhotos(recipe);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The 401 cleared the library already; write nothing back into it.
        throw err;
      }
      // Any other failure may have left the recipe on the server: at the
      // batch, where the client cannot tell which op failed, or at a photo.
      const remap = await discardCreatedRecipe(recipe.id, staged);
      throw remap === 'signedOut' ? new SessionExpiredError() : new CreateRollbackError(err, remap);
    }
    return recipe;
  },

  async remove(id: string): Promise<void> {
    if (isSharedRecipe(id)) {
      throw new Error(t('error.sharedViewOnly'));
    }
    const previous = captureSnapshot();
    const at = Date.now();
    // Nothing else drops the id from collections, and a dead id still counts
    // against the per-collection cap, so scrub membership alongside the recipe.
    const staleIn = listCollections().filter((c) => c.recipeIds.includes(id));
    const scrubbed = staleIn.map((c) =>
      compactCollection({
        ...c,
        recipeIds: c.recipeIds.filter((recipeId) => recipeId !== id),
        updatedAt: at,
      }),
    );
    // The server tombstones the recipe before the rest of the delete finishes.
    // A failed response can still mean the recipe is gone. A pull that started
    // before this write can also paint the old card back. Hold the library
    // until the push settles, then read the server instead of restoring blindly.
    const writeEpoch = beginLocalWrite();
    removeRecipeLocal(id);
    for (const collection of scrubbed) {
      upsertCollection(collection);
    }
    const ops: PushOp[] = [{ kind: 'recipe.delete', payload: { id, updatedAt: at } }];
    for (const collection of scrubbed) {
      ops.push({ kind: 'collection.put', payload: collection });
    }
    let result: Awaited<ReturnType<typeof pushOps>>;
    try {
      result = await pushOps(ops);
    } finally {
      endLocalWrite();
    }
    const overlaps = localWriteOverlapsPull(writeEpoch);
    if (result === 'ok' && !overlaps) {
      return;
    }
    const outcome = await pullAfterLocalWrite(writeEpoch);
    if (result === 'ok') {
      return;
    }
    if (outcome === 'signedOut') {
      throw new Error(t('error.sessionExpired'));
    }
    if (outcome === 'ok') {
      if (getRecipe(id) === undefined) {
        return;
      }
      throw new Error(t('error.recipeDelete'));
    }
    if (libraryEpoch() === writeEpoch) {
      restoreSnapshot(previous);
    }
    throw new Error(
      result === 'signedOut'
        ? t('error.sessionExpired')
        : t('error.recipeDelete'),
    );
  },
};

/** Reactive list of all recipes, newest first. `undefined` while loading. */
export function useRecipes(): Recipe[] | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    if (!snap.loaded) {
      return undefined;
    }
    return listRecipes();
  }, [snap]);
}

/** Reactive single recipe. `undefined` while loading, `null` if not found. */
export function useRecipe(id: string | undefined): Recipe | null | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  if (!snap.loaded) {
    return undefined;
  }
  if (!id) {
    return null;
  }
  return snap.recipes.get(id) ?? null;
}
