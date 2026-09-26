import { useMemo, useSyncExternalStore } from 'react';
import {
  dropPhoto,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  listRecipes,
  markPhotoRemote,
  removeRecipeLocal,
  subscribe,
  upsertRecipe,
  getCollection,
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  upsertCollection,
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
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
    const previous = getRecipe(id);
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
    removeRecipeLocal(id);
    for (const collection of scrubbed) {
      upsertCollection(collection);
    }
    const ops: PushOp[] = [{ kind: 'recipe.delete', payload: { id, updatedAt: at } }];
    for (const collection of scrubbed) {
      ops.push({ kind: 'collection.put', payload: collection });
    }
    const result = await pushOps(ops);
    if (result !== 'ok') {
      if (previous) {
        upsertRecipe(previous);
      }
      for (const collection of staleIn) {
        upsertCollection(collection);
      }
      throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't delete the recipe.");
    }
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
