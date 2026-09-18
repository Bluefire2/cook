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
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import { compactRecipe } from './compactRecipe';
import type { Recipe, RecipeDraft } from './types';

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

async function deletePhotoIfReplaced(
  before: string | undefined,
  after: string | undefined,
): Promise<void> {
  if (before === undefined || before === after) {
    return;
  }
  const at = Date.now();
  const result = await pushOps([{ kind: 'photo.delete', payload: { id: before, updatedAt: at } }]);
  if (result === 'ok') {
    dropPhoto(before);
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
    const previous = getRecipe(recipe.id);
    const next = compactRecipe({ ...recipe, updatedAt: Date.now() });
    upsertRecipe(next);
    try {
      await uploadPhotoIfNeeded(next.photoId, next.id, next.updatedAt);
      const result = await pushOps([{ kind: 'recipe.put', payload: next }]);
      if (result !== 'ok') {
        throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't save the recipe.");
      }
      await deletePhotoIfReplaced(previous?.photoId, next.photoId);
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
   * cannot express `sourceUrl` or `photoId` — a spread would blank them.
   */
  async applyDraft(id: string, draft: RecipeDraft): Promise<void> {
    const existing = getRecipe(id);
    if (!existing) throw new Error(`No recipe with id ${id}.`);
    const photoId = draft.photoId ?? existing.photoId;
    const next = compactRecipe({
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
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
    });
    upsertRecipe(next);
    try {
      await uploadPhotoIfNeeded(next.photoId, next.id, next.updatedAt);
      const result = await pushOps([{ kind: 'recipe.put', payload: next }]);
      if (result !== 'ok') {
        throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't save the recipe.");
      }
      await deletePhotoIfReplaced(existing.photoId, next.photoId);
    } catch (err) {
      upsertRecipe(existing);
      throw err;
    }
  },

  async create(
    data: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Recipe> {
    const now = Date.now();
    const recipe = compactRecipe({
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    upsertRecipe(recipe);
    try {
      await uploadPhotoIfNeeded(recipe.photoId, recipe.id, recipe.updatedAt);
      const result = await pushOps([{ kind: 'recipe.put', payload: recipe }]);
      if (result !== 'ok') {
        throw new Error(result === 'signedOut' ? 'Please sign in again — your session expired.' : "Couldn't save the recipe.");
      }
    } catch (err) {
      removeRecipeLocal(recipe.id);
      throw err;
    }
    return recipe;
  },

  async remove(id: string): Promise<void> {
    const previous = getRecipe(id);
    const at = Date.now();
    removeRecipeLocal(id);
    const result = await pushOps([{ kind: 'recipe.delete', payload: { id, updatedAt: at } }]);
    if (result !== 'ok') {
      if (previous) {
        upsertRecipe(previous);
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
