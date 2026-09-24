import type { LiveIncomingShare } from './grants.ts';
import { canViewCollection, canViewRecipe } from './shareAuth.ts';
import {
  compactCollectionFields,
  compactRecipeFields,
  isLiveDoc,
  type StoreKind,
} from './store.ts';

export type SharedCursor = { grantId: string; recipeId: string };

type ReadDocData = (
  uid: string,
  kind: StoreKind,
  id: string,
) => Promise<Record<string, unknown> | undefined>;

export type BuildSharedPullPageInput = {
  viewerSub: string;
  cursor: SharedCursor;
  limit: number;
  listLiveIncomingShares: (viewerSub: string) => Promise<LiveIncomingShare[]>;
  readLiveIncomingShare: (
    viewerSub: string,
    grantId: string,
  ) => Promise<LiveIncomingShare | undefined>;
  readDocData: ReadDocData;
};

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
  input: BuildSharedPullPageInput,
): Promise<{
  changes: {
    collections: Record<string, unknown>[];
    recipes: Record<string, unknown>[];
    photos: Record<string, unknown>[];
  };
  cursor: SharedCursor;
  hasMore: boolean;
}> {
  const shares = await input.listLiveIncomingShares(input.viewerSub);
  const start = shares.findIndex((share) => {
    if (input.cursor.grantId === '') {
      return true;
    }
    return (
      share.grantId > input.cursor.grantId ||
      share.grantId === input.cursor.grantId
    );
  });
  const empty = {
    changes: { collections: [], recipes: [], photos: [] },
    cursor: input.cursor,
    hasMore: false,
  };
  if (start === -1) {
    return empty;
  }

  for (let i = start; i < shares.length; i += 1) {
    const candidate = shares[i];
    const share = await input.readLiveIncomingShare(
      input.viewerSub,
      candidate.grantId,
    );
    if (
      share === undefined ||
      share.grantId !== candidate.grantId ||
      share.ownerSub !== candidate.ownerSub ||
      share.collectionId !== candidate.collectionId
    ) {
      continue;
    }
    const collection = await input.readDocData(
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
    const resume =
      share.grantId === input.cursor.grantId ? input.cursor.recipeId : '';
    const pending = listed.filter((id) => afterRecipeCursor(id, resume));
    if (share.grantId === input.cursor.grantId && pending.length === 0) {
      continue;
    }
    const pageIds = pending.slice(0, input.limit);
    const recipes: Record<string, unknown>[] = [];
    const photos: Record<string, unknown>[] = [];
    for (const recipeId of pageIds) {
      const recipe = await input.readDocData(
        share.ownerSub,
        'recipes',
        recipeId,
      );
      if (!canViewRecipe(recipeId, share, collection, recipe)) {
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
        const photo = await input.readDocData(
          share.ownerSub,
          'photos',
          photoId,
        );
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
