import { isLiveDoc } from './store.ts';

/**
 * A grantee's role on one shared collection. The collection owner is not a
 * grant and has no role here. A stored value that is missing or unknown reads
 * as `viewer`, so every grant written before roles existed stays view-only.
 */
export type ShareRole = 'viewer' | 'editor';

export function parseShareRole(raw: unknown): ShareRole {
  return raw === 'editor' ? 'editor' : 'viewer';
}

/** A request body role: omitted means viewer, anything else unknown is invalid. */
export function requestedShareRole(raw: unknown): ShareRole | null {
  if (raw === undefined) {
    return 'viewer';
  }
  return raw === 'viewer' || raw === 'editor' ? raw : null;
}

export function strongerShareRole(a: ShareRole, b: ShareRole): ShareRole {
  return a === 'editor' || b === 'editor' ? 'editor' : 'viewer';
}

export type IncomingShare = {
  ownerSub: string;
  collectionId: string;
  grantId: string;
};

export function canViewCollection(
  share: IncomingShare,
  collection: Record<string, unknown> | undefined,
): boolean {
  if (collection === undefined || !isLiveDoc(collection)) {
    return false;
  }
  return collection.id === share.collectionId;
}

export function canViewRecipe(
  recipeId: string,
  share: IncomingShare,
  collection: Record<string, unknown> | undefined,
  recipe: Record<string, unknown> | undefined,
): recipe is Record<string, unknown> {
  if (!canViewCollection(share, collection) || collection === undefined) {
    return false;
  }
  const ids = Array.isArray(collection.recipeIds) ? collection.recipeIds : [];
  if (!ids.includes(recipeId)) {
    return false;
  }
  return recipe !== undefined && isLiveDoc(recipe);
}

export function recipeListsPhoto(
  recipe: Record<string, unknown>,
  photoId: string,
): boolean {
  if (recipe.photoId === photoId) {
    return true;
  }
  return Array.isArray(recipe.galleryPhotoIds) && recipe.galleryPhotoIds.includes(photoId);
}
