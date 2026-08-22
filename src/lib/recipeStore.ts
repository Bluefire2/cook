import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Recipe, RecipeDraft } from './types';

export const recipeStore = {
  list(): Promise<Recipe[]> {
    return db.recipes.orderBy('updatedAt').reverse().toArray();
  },

  get(id: string): Promise<Recipe | undefined> {
    return db.recipes.get(id);
  },

  async save(recipe: Recipe): Promise<void> {
    await db.recipes.put({ ...recipe, updatedAt: Date.now() });
  },

  /**
   * Merges a draft into the recipe with this id. Every field is named rather
   * than spread because drafts come from the `update_recipe` tool, whose schema
   * cannot express `sourceUrl` or `photoId` — a spread would blank them.
   */
  async applyDraft(id: string, draft: RecipeDraft): Promise<void> {
    await db.transaction('rw', db.recipes, async () => {
      const existing = await db.recipes.get(id);
      if (!existing) throw new Error(`No recipe with id ${id}.`);
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
        photoId: draft.photoId ?? existing.photoId,
      });
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
    await db.transaction('rw', [db.recipes, db.chatMessages], async () => {
      await db.recipes.delete(id);
      await db.chatMessages.where('recipeId').equals(id).delete();
    });
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
