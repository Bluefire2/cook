import { useMemo, useSyncExternalStore } from 'react';
import {
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
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  upsertCollection,
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

async function uploadPhotoIfNeeded(
  photoId: string | undefined,
  recipeId: string,
  updatedAt: number,
): Promise<void> {
  if (photoId === undefined) {
    return;
  }
  const blob = getPendingBlob(photoId);
  if (!blob) {
    return;
  }
  const result = await postPhoto(photoId, recipeId, updatedAt, blob);
  if (result !== 'ok') {
    throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't save the photo.");
  }
  markPhotoRemote(photoId);
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
    throw new Error('Please sign in again — your session expired.');
  }
  if (loaded.some((item) => item === 'unavailable')) {
    throw new Error("Couldn't copy the photos. Try again.");
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

async function uploadRecipePhotos(recipe: Recipe): Promise<void> {
  for (const photoId of recipePhotoIds(recipe)) {
    await uploadPhotoIfNeeded(photoId, recipe.id, recipe.updatedAt);
  }
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
    const at = Date.now();
    const result = await pushOps([
      { kind: 'photo.delete', payload: { id: photoId, updatedAt: at } },
    ]);
    if (result === 'ok') {
      dropPhoto(photoId);
    }
  }
}

export const recipeStore = {
  list(): Recipe[] {
    return listRecipes();
  },

  get(id: string): Recipe | undefined {
    return getRecipe(id);
  },

  /** True for a recipe that arrived through an incoming share (view-only). */
  isShared(id: string): boolean {
    return isSharedRecipe(id);
  },

  async save(recipe: Recipe): Promise<void> {
    if (isSharedRecipe(recipe.id)) {
      throw new Error('This shared collection is view-only.');
    }
    const previous = getRecipe(recipe.id);
    const next = compactRecipe({ ...recipe, updatedAt: Date.now() });
    upsertRecipe(next);
    try {
      await uploadRecipePhotos(next);
      const result = await pushOps([{ kind: 'recipe.put', payload: next }]);
      if (result !== 'ok') {
        throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't save the recipe.");
      }
      await deleteRemovedPhotos(previous, next);
    } catch (err) {
      if (previous) {
        upsertRecipe(previous);
      } else {
        removeRecipeLocal(next.id);
      }
      throw err;
    }
  },

  /**
   * Merges a draft into the recipe with this id. Every field is named rather
   * than spread because drafts come from the `update_recipe` tool, whose schema
   * cannot express `sourceUrl`, `photoId`, or `galleryPhotoIds` — a spread
   * would blank them.
   */
  async applyDraft(id: string, draft: RecipeDraft): Promise<void> {
    const existing = getRecipe(id);
    if (!existing) throw new Error(`No recipe with id ${id}.`);
    const photoId = draft.photoId ?? existing.photoId;
    const galleryPhotoIds = draft.galleryPhotoIds ?? existing.galleryPhotoIds;
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
      photoId,
      galleryPhotoIds,
    });
  },

  /**
   * A new recipe from an Ask proposal. Photos come from `parent`, copied onto
   * new ids. Fields on the draft never supply a photo.
   */
  async createFromAsk(parent: Recipe, draft: RecipeDraft): Promise<Recipe> {
    const copied = await copyParentPhotos(parent);
    return recipeStore.create({
      ...draft,
      photoId: copied.photoId,
      galleryPhotoIds: copied.galleryPhotoIds,
    });
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
        throw new Error('Collection not found.');
      }
      if (wouldExceedRecipeIdCap([...previousCollection.recipeIds, recipe.id])) {
        throw new Error('This collection is full.');
      }
      nextCollection = compactCollection({
        ...previousCollection,
        recipeIds: [...previousCollection.recipeIds, recipe.id],
        updatedAt: now,
      });
    }
    upsertRecipe(recipe);
    if (nextCollection) {
      upsertCollection(nextCollection);
    }
    try {
      await uploadRecipePhotos(recipe);
      const ops: PushOp[] = [{ kind: 'recipe.put', payload: recipe }];
      if (nextCollection) {
        ops.push({ kind: 'collection.put', payload: nextCollection });
      }
      const result = await pushOps(ops);
      if (result !== 'ok') {
        throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't save the recipe.");
      }
    } catch (err) {
      removeRecipeLocal(recipe.id);
      if (previousCollection) {
        upsertCollection(previousCollection);
      }
      throw err;
    }
    return recipe;
  },

  async remove(id: string): Promise<void> {
    if (isSharedRecipe(id)) {
      throw new Error('This shared collection is view-only.');
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
      throw new Error('Please sign in again — your session expired.');
    }
    if (outcome === 'ok') {
      if (getRecipe(id) === undefined) {
        return;
      }
      throw new Error("Couldn't delete the recipe.");
    }
    if (libraryEpoch() === writeEpoch) {
      restoreSnapshot(previous);
    }
    throw new Error(
      result === 'signedOut'
        ? 'Please sign in again — your session expired.'
        : "Couldn't delete the recipe.",
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
