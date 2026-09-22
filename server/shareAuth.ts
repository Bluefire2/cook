import { isLiveDoc } from './store.ts';

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
): boolean {
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

export function canViewPhoto(
  photoId: string,
  share: IncomingShare,
  collection: Record<string, unknown> | undefined,
  recipes: Record<string, unknown>[],
): boolean {
  if (!canViewCollection(share, collection) || collection === undefined) {
    return false;
  }
  const listed = new Set(
    Array.isArray(collection.recipeIds) ? collection.recipeIds : [],
  );
  for (const recipe of recipes) {
    if (!isLiveDoc(recipe)) {
      continue;
    }
    if (typeof recipe.id !== 'string' || !listed.has(recipe.id)) {
      continue;
    }
    if (recipeListsPhoto(recipe, photoId)) {
      return true;
    }
  }
  return false;
}
