import type { Collection } from './types';

export const MAX_NAMED_COLLECTIONS = 50;
export const MAX_COLLECTION_RECIPE_IDS = 500;
export const MAX_COLLECTION_NAME_LENGTH = 80;

export function uniqueRecipeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_COLLECTION_RECIPE_IDS) {
      break;
    }
  }
  return next;
}

export function compactCollectionName(name: unknown): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/**
 * `put` replaces the whole record. Drop unknown keys and normalize
 * `recipeIds` so apply and save leave the same shape.
 */
export function compactCollection(collection: Collection): Collection {
  return {
    id: collection.id,
    name: collection.name.trim(),
    recipeIds: uniqueRecipeIds(collection.recipeIds),
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}
