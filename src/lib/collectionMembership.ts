import { MAX_COLLECTION_RECIPE_IDS } from './compactCollection';
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
  return recipes.filter((recipe) => membership.get(recipe.id) === collection.id);
}

export function moveRecipes(
  collections: readonly Collection[],
  recipeIds: readonly string[],
  dest: 'default' | string,
  now: number,
): Collection[] {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const id of recipeIds) {
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    wanted.push(id);
  }
  if (wanted.length === 0) {
    return [];
  }
  const wantedSet = new Set(wanted);

  const changed: Collection[] = [];
  for (const collection of collections) {
    const before = collection.recipeIds;
    const isDest = dest !== 'default' && collection.id === dest;
    let next: string[];
    if (isDest) {
      // Keep ids already listed here in place. Removing them and appending
      // again reorders the collection and writes a no-op last-write-wins put.
      next = before.slice();
      const inDest = new Set(before);
      for (const id of wanted) {
        if (!inDest.has(id)) {
          next.push(id);
          inDest.add(id);
        }
      }
    } else {
      next = before.filter((id) => !wantedSet.has(id));
    }
    if (next.length !== before.length || next.some((id, i) => id !== before[i])) {
      changed.push({ ...collection, recipeIds: next, updatedAt: now });
    }
  }
  return changed;
}

export function moveRecipe(
  collections: readonly Collection[],
  recipeId: string,
  dest: 'default' | string,
  now: number,
): Collection[] {
  return moveRecipes(collections, [recipeId], dest, now);
}

export function wouldExceedRecipeIdCap(recipeIds: readonly string[]): boolean {
  return recipeIds.length > MAX_COLLECTION_RECIPE_IDS;
}
