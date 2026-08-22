import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Recipe, RecipeDraft } from './types';

/**
 * Called inside the transaction that rewrote the reference, so a save that
 * rolls back keeps its blob instead of leaving a recipe pointing at nothing.
 * Photos are the only thing here big enough to exhaust a device's quota, so an
 * unreferenced one cannot just be left behind.
 */
async function deleteReplacedPhoto(
  before: string | undefined,
  after: string | undefined,
): Promise<void> {
  if (before !== undefined && before !== after) {
    await db.photos.delete(before);
  }
}

export const recipeStore = {
  list(): Promise<Recipe[]> {
    return db.recipes.orderBy('updatedAt').reverse().toArray();
  },

  get(id: string): Promise<Recipe | undefined> {
    return db.recipes.get(id);
  },

  async save(recipe: Recipe): Promise<void> {
    await db.transaction('rw', [db.recipes, db.photos], async () => {
      const previous = await db.recipes.get(recipe.id);
      await db.recipes.put({ ...recipe, updatedAt: Date.now() });
      await deleteReplacedPhoto(previous?.photoId, recipe.photoId);
    });
  },

  /**
   * Merges a draft into the recipe with this id. Every field is named rather
   * than spread because drafts come from the `update_recipe` tool, whose schema
   * cannot express `sourceUrl` or `photoId` — a spread would blank them.
   */
  async applyDraft(id: string, draft: RecipeDraft): Promise<void> {
    await db.transaction('rw', [db.recipes, db.photos], async () => {
      const existing = await db.recipes.get(id);
      if (!existing) throw new Error(`No recipe with id ${id}.`);
      const photoId = draft.photoId ?? existing.photoId;
      await db.recipes.put({
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
      await deleteReplacedPhoto(existing.photoId, photoId);
    });
  },

  async create(
    data: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Recipe> {
    const now = Date.now();
    const recipe: Recipe = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await db.recipes.add(recipe);
    return recipe;
  },

  async remove(id: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.recipes, db.chatMessages, db.photos, db.cookState],
      async () => {
        const recipe = await db.recipes.get(id);
        const messages = await db.chatMessages
          .where('recipeId')
          .equals(id)
          .toArray();

        await db.recipes.delete(id);
        await db.chatMessages.where('recipeId').equals(id).delete();
        await db.cookState.delete(id);
        // Nothing else references these, so they go with the recipe or never.
        await db.photos.bulkDelete([
          ...(recipe?.photoId !== undefined ? [recipe.photoId] : []),
          ...messages.flatMap((m) => m.photoIds ?? []),
        ]);
      },
    );
  },
};

/** Reactive list of all recipes, newest first. `undefined` while loading. */
export function useRecipes(): Recipe[] | undefined {
  return useLiveQuery(() => recipeStore.list(), []);
}

/** Reactive single recipe. `undefined` while loading, `null` if not found. */
export function useRecipe(id: string | undefined): Recipe | null | undefined {
  return useLiveQuery(
    async () => (id ? ((await recipeStore.get(id)) ?? null) : null),
    [id],
  );
}
