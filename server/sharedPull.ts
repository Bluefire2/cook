import { listLiveIncomingShares } from './grants.ts';
import { canViewCollection } from './shareAuth.ts';
import {
  compactCollectionFields,
  compactRecipeFields,
  isLiveDoc,
  readDocData,
} from './store.ts';

export type SharedCursor = { grantId: string; recipeId: string };

export function encodeSharedCursor(cursor: SharedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSharedCursor(raw: string | null): SharedCursor {
  if (raw === null || raw === '') {
    return { grantId: '', recipeId: '' };
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { grantId: '', recipeId: '' };
    }
    const record = parsed as { grantId?: unknown; recipeId?: unknown };
    return {
      grantId: typeof record.grantId === 'string' ? record.grantId : '',
      recipeId: typeof record.recipeId === 'string' ? record.recipeId : '',
    };
  } catch {
    return { grantId: '', recipeId: '' };
  }
}

function afterRecipeCursor(recipeId: string, cursorRecipeId: string): boolean {
  if (cursorRecipeId === '') {
    return true;
  }
  return recipeId > cursorRecipeId;
}

export async function buildSharedPullPage(
  viewerSub: string,
  cursor: SharedCursor,
  limit: number,
): Promise<{
  changes: {
    collections: Record<string, unknown>[];
    recipes: Record<string, unknown>[];
    photos: Record<string, unknown>[];
  };
  cursor: SharedCursor;
  hasMore: boolean;
}> {
  const shares = await listLiveIncomingShares(viewerSub);
  const start = shares.findIndex((share) => {
    if (cursor.grantId === '') {
      return true;
    }
    return share.grantId > cursor.grantId || share.grantId === cursor.grantId;
  });
  const empty = {
    changes: { collections: [], recipes: [], photos: [] },
    cursor,
    hasMore: false,
  };
  if (start === -1) {
    return empty;
  }

  for (let i = start; i < shares.length; i += 1) {
    const share = shares[i];
    const collection = await readDocData(
      share.ownerSub,
      'collections',
      share.collectionId,
    );
    if (
      !canViewCollection(
        {
          ownerSub: share.ownerSub,
          collectionId: share.collectionId,
          grantId: share.grantId,
        },
        collection,
      ) ||
      collection === undefined
    ) {
      continue;
    }
    const listed = Array.isArray(collection.recipeIds)
      ? collection.recipeIds.filter((id): id is string => typeof id === 'string')
      : [];
    listed.sort();
    const resume = share.grantId === cursor.grantId ? cursor.recipeId : '';
    const pending = listed.filter((id) => afterRecipeCursor(id, resume));
    if (share.grantId === cursor.grantId && pending.length === 0) {
      continue;
    }
    const pageIds = pending.slice(0, limit);
    const recipes: Record<string, unknown>[] = [];
    const photos: Record<string, unknown>[] = [];
    for (const recipeId of pageIds) {
      const recipe = await readDocData(share.ownerSub, 'recipes', recipeId);
      if (recipe === undefined || !isLiveDoc(recipe)) {
        continue;
      }
      const compact = compactRecipeFields({ ...recipe, id: recipeId });
      recipes.push({ ...compact, ownerSub: share.ownerSub });
      const photoIds: string[] = [];
      if (typeof compact.photoId === 'string') {
        photoIds.push(compact.photoId);
      }
      if (Array.isArray(compact.galleryPhotoIds)) {
        for (const id of compact.galleryPhotoIds) {
          if (typeof id === 'string' && !photoIds.includes(id)) {
            photoIds.push(id);
          }
        }
      }
      for (const photoId of photoIds) {
        const photo = await readDocData(share.ownerSub, 'photos', photoId);
        if (photo === undefined || !isLiveDoc(photo)) {
          continue;
        }
        photos.push({
          id: photoId,
          recipeId,
          contentType: photo.contentType,
          size: photo.size,
          createdAt: photo.createdAt,
        });
      }
    }
    const moreInGrant = pending.length > pageIds.length;
    const moreGrants = i < shares.length - 1;
    const lastRecipeId = moreInGrant
      ? pageIds[pageIds.length - 1] ?? resume
      : '\uFFFF';
    return {
      changes: {
        collections: [
          {
            ...compactCollectionFields({ ...collection, id: share.collectionId }),
            ownerSub: share.ownerSub,
          },
        ],
        recipes,
        photos,
      },
      cursor: { grantId: share.grantId, recipeId: lastRecipeId },
      hasMore: moreInGrant || moreGrants,
    };
  }

  return empty;
}
