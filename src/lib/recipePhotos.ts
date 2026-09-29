import type { Recipe } from './types';

/** Same cap as chat `photoIds` — gallery photos are not sent to Gemini. */
export const MAX_GALLERY_PHOTOS = 8;

/**
 * Unique, ordered gallery FKs. The cover is never also a gallery tile; an
 * empty list becomes `undefined` so `put` does not store a blank key.
 */
export function compactGalleryPhotoIds(
  ids: readonly string[] | undefined,
  coverId: string | undefined,
): string[] | undefined {
  if (ids === undefined || ids.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (id === '' || id === coverId || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_GALLERY_PHOTOS) {
      break;
    }
  }
  return next.length > 0 ? next : undefined;
}

/** Cover then gallery, de-duplicated, for upload / delete / backup walks. */
export function recipePhotoIds(recipe: Pick<Recipe, 'photoId' | 'galleryPhotoIds'>): string[] {
  const ids: string[] = [];
  if (recipe.photoId !== undefined) {
    ids.push(recipe.photoId);
  }
  for (const id of recipe.galleryPhotoIds ?? []) {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The same draft with each photo id replaced by its entry in `remap`. Ids not
 * in `remap` stay. Used after a failed create moved staged bytes to new ids.
 */
export function remapPhotoIds<T extends Pick<Recipe, 'photoId' | 'galleryPhotoIds'>>(
  draft: T,
  remap: ReadonlyMap<string, string>,
): T {
  if (remap.size === 0) {
    return draft;
  }
  const next = { ...draft };
  if (draft.photoId !== undefined) {
    next.photoId = remap.get(draft.photoId) ?? draft.photoId;
  }
  if (draft.galleryPhotoIds !== undefined) {
    next.galleryPhotoIds = draft.galleryPhotoIds.map((id) => remap.get(id) ?? id);
  }
  return next;
}
