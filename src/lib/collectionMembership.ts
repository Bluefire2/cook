import {
  MAX_COLLECTION_RECIPE_IDS,
  MAX_NAMED_COLLECTIONS,
} from './compactCollection';
import type { Collection, Recipe } from './types';

/** Smallest collection id wins when a recipe id appears in two live lists. */
export function winningMembership(
  collections: readonly Collection[],
): Map<string, string> {
  const sorted = [...collections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const map = new Map<string, string>();
  for (const collection of sorted) {
    for (const recipeId of collection.recipeIds) {
      if (!map.has(recipeId)) {
        map.set(recipeId, collection.id);
      }
    }
  }
  return map;
}

export function collectionIdForRecipe(
  collections: readonly Collection[],
  recipeId: string,
): string | undefined {
  return winningMembership(collections).get(recipeId);
}

export function unfiledRecipes(
  recipes: readonly Recipe[],
  collections: readonly Collection[],
): Recipe[] {
  const claimed = winningMembership(collections);
  return recipes.filter((recipe) => !claimed.has(recipe.id));
}

export function recipesInCollection(
  recipes: readonly Recipe[],
  collection: Collection,
  allCollections: readonly Collection[],
): Recipe[] {
  const membership = winningMembership(allCollections);
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const out: Recipe[] = [];
  for (const recipeId of collection.recipeIds) {
    if (membership.get(recipeId) !== collection.id) {
      continue;
    }
    const recipe = byId.get(recipeId);
    if (recipe) {
      out.push(recipe);
    }
  }
  return out;
}

export function moveRecipe(
  collections: readonly Collection[],
  recipeId: string,
  dest: 'default' | string,
  now: number,
): Collection[] {
  const changed: Collection[] = [];
  for (const collection of collections) {
    const has = collection.recipeIds.includes(recipeId);
    const shouldHave = dest !== 'default' && collection.id === dest;
    if (has === shouldHave) {
      continue;
    }
    const recipeIds = shouldHave
      ? [...collection.recipeIds, recipeId]
      : collection.recipeIds.filter((id) => id !== recipeId);
    changed.push({ ...collection, recipeIds, updatedAt: now });
  }
  return changed;
}

export function wouldExceedNamedCollectionCap(
  liveCount: number,
  creating: boolean,
): boolean {
  return creating && liveCount >= MAX_NAMED_COLLECTIONS;
}

export function wouldExceedRecipeIdCap(recipeIds: readonly string[]): boolean {
  return recipeIds.length > MAX_COLLECTION_RECIPE_IDS;
}
