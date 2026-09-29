import { afterEach, describe, expect, it, vi } from 'vitest';
import { t, translate } from '../i18n';
import { CreateRollbackError, recipeStore } from './recipeStore';
import {
  addPendingBlob,
  clearLibrary,
  getCollection,
  getRecipe,
  getSnapshot,
  listCollections,
  listRecipes,
  upsertCollection,
} from './libraryMemory';
import { remapPhotoIds } from './recipePhotos';
import { postPhoto, pushOps } from './remote';
import { settings } from './settings';
import { installPhotoServerFake } from './testPhotoServer';
import type { PushOp } from './pushOps';
import type { Collection, RecipeDraft } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
  fetchPhotoBlobOutcome: vi.fn(),
}));

const COVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GALLERY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COLLECTION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXISTING_RECIPE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const draft: RecipeDraft = {
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: [],
};

const collection: Collection = {
  id: COLLECTION_ID,
  name: 'Dinners',
  recipeIds: [EXISTING_RECIPE],
  createdAt: 1,
  updatedAt: 2,
};

function stagePhotos(): void {
  addPendingBlob(COVER, new Blob(['cover'], { type: 'image/jpeg' }));
  addPendingBlob(GALLERY, new Blob(['gallery'], { type: 'image/jpeg' }));
}

function putIds(pushed: PushOp[]): string[] {
  return pushed.flatMap((op) => (op.kind === 'recipe.put' ? [op.payload.id] : []));
}

/** What CreateRecipeForm does before offering Try again. */
function draftAfterFailure<T extends RecipeDraft>(input: T, err: unknown): T {
  return err instanceof CreateRollbackError ? remapPhotoIds(input, err.photoIdRemap) : input;
}

async function failedCreate(input: RecipeDraft, collectionId?: string): Promise<unknown> {
  try {
    await recipeStore.create(input, collectionId ? { collectionId } : undefined);
  } catch (err) {
    return err;
  }
  throw new Error('create unexpectedly succeeded');
}

afterEach(() => {
  clearLibrary();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.restoreAllMocks();
});

describe('recipeStore.create with photos', () => {
  it('pushes the recipe before uploading its photos', async () => {
    stagePhotos();
    upsertCollection(collection);
    const server = installPhotoServerFake();

    const created = await recipeStore.create(
      { ...draft, photoId: COVER, galleryPhotoIds: [GALLERY] },
      { collectionId: COLLECTION_ID },
    );

    expect(server.calls).toEqual([
      'push:recipe.put',
      'push:collection.put',
      `photo:${COVER}`,
      `photo:${GALLERY}`,
    ]);
    expect(getRecipe(created.id)?.photoId).toBe(COVER);
    expect(getCollection(COLLECTION_ID)?.recipeIds).toEqual([EXISTING_RECIPE, created.id]);
    expect(getSnapshot().remotePhotoIds).toEqual(new Set([COVER, GALLERY]));
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('uploads nothing and deletes the recipe when the recipe push fails', async () => {
    stagePhotos();
    upsertCollection(collection);
    const server = installPhotoServerFake({
      failPush: (ops) => (ops[0]?.kind === 'recipe.put' ? 'error' : undefined),
    });

    const err = await failedCreate(
      { ...draft, photoId: COVER, galleryPhotoIds: [GALLERY] },
      COLLECTION_ID,
    );

    expect(err).toBeInstanceOf(CreateRollbackError);
    expect((err as Error).message).toBe(t('error.recipeSave'));
    expect(postPhoto).not.toHaveBeenCalled();
    expect(server.calls).toEqual([
      'push:recipe.put',
      'push:collection.put',
      'push:recipe.delete',
      'push:collection.put',
    ]);
    expect(listRecipes()).toEqual([]);
    expect(getCollection(COLLECTION_ID)?.recipeIds).toEqual([EXISTING_RECIPE]);
    // The delete landed, so the same ids are safe to reuse.
    expect((err as CreateRollbackError).photoIdRemap.size).toBe(0);
    expect([...getSnapshot().pendingBlobs.keys()].sort()).toEqual([COVER, GALLERY]);
  });

  it('deletes the recipe when the batch applied but its response was lost', async () => {
    stagePhotos();
    let lost = 1;
    const server = installPhotoServerFake({
      failAfterApply: () => {
        if (lost > 0) {
          lost -= 1;
          return 'error';
        }
        return undefined;
      },
    });

    const err = await failedCreate({ ...draft, photoId: COVER });

    expect(err).toBeInstanceOf(CreateRollbackError);
    const [firstId] = putIds(server.pushed);
    expect(server.calls).toEqual(['push:recipe.put', 'push:recipe.delete']);
    expect(server.pushed.at(-1)).toMatchObject({ kind: 'recipe.delete', payload: { id: firstId } });
    expect(server.liveRecipeIds.size).toBe(0);
    expect(postPhoto).not.toHaveBeenCalled();
  });

  it('deletes the recipe when the collection op in the batch is rejected', async () => {
    stagePhotos();
    upsertCollection(collection);
    const server = installPhotoServerFake({
      failAfterApply: (ops) =>
        ops[0]?.kind === 'recipe.put' && ops.some((op) => op.kind === 'collection.put')
          ? 'invalid'
          : undefined,
    });

    const err = await failedCreate({ ...draft, photoId: COVER }, COLLECTION_ID);

    expect(err).toBeInstanceOf(CreateRollbackError);
    const [firstId] = putIds(server.pushed);
    expect(server.calls).toEqual([
      'push:recipe.put',
      'push:collection.put',
      'push:recipe.delete',
      'push:collection.put',
    ]);
    expect(server.pushed.find((op) => op.kind === 'recipe.delete')).toMatchObject({
      payload: { id: firstId },
    });
    expect(server.liveRecipeIds.size).toBe(0);
    expect(listRecipes()).toEqual([]);
    expect(getCollection(COLLECTION_ID)?.recipeIds).toEqual([EXISTING_RECIPE]);
  });

  it('deletes the recipe and scrubs its collection when a photo upload fails', async () => {
    stagePhotos();
    upsertCollection(collection);
    const server = installPhotoServerFake({
      failPhoto: (id) => (id === GALLERY ? 'unavailable' : undefined),
    });

    await expect(
      recipeStore.create(
        { ...draft, photoId: COVER, galleryPhotoIds: [GALLERY] },
        { collectionId: COLLECTION_ID },
      ),
    ).rejects.toThrow(t('error.photoSave'));

    const put = server.pushed.find((op) => op.kind === 'recipe.put');
    const recipeId = put?.kind === 'recipe.put' ? put.payload.id : undefined;
    expect(server.calls).toEqual([
      'push:recipe.put',
      'push:collection.put',
      `photo:${COVER}`,
      `photo:${GALLERY}`,
      'push:recipe.delete',
      'push:collection.put',
    ]);
    const deleteOps = server.pushed.slice(2);
    expect(deleteOps[0]).toMatchObject({ kind: 'recipe.delete', payload: { id: recipeId } });
    expect(deleteOps[1]).toMatchObject({
      kind: 'collection.put',
      payload: { id: COLLECTION_ID, recipeIds: [EXISTING_RECIPE] },
    });
    expect(server.liveRecipeIds.size).toBe(0);
    expect(listRecipes()).toEqual([]);
    expect(getCollection(COLLECTION_ID)?.recipeIds).toEqual([EXISTING_RECIPE]);
    // Staged bytes stay for a retry, including the cover that did upload.
    expect([...getSnapshot().pendingBlobs.keys()].sort()).toEqual([COVER, GALLERY]);
    expect(getSnapshot().remotePhotoIds.size).toBe(0);
  });

  it('uploads the same staged photos when create is retried after a photo failure', async () => {
    stagePhotos();
    const coverBlob = getSnapshot().pendingBlobs.get(COVER);
    const galleryBlob = getSnapshot().pendingBlobs.get(GALLERY);
    let galleryFailures = 1;
    const server = installPhotoServerFake({
      failPhoto: (id) => {
        if (id === GALLERY && galleryFailures > 0) {
          galleryFailures -= 1;
          return 'error';
        }
        return undefined;
      },
    });
    const input = { ...draft, photoId: COVER, galleryPhotoIds: [GALLERY] };

    await expect(recipeStore.create(input)).rejects.toThrow(t('error.photoSave'));
    vi.mocked(postPhoto).mockClear();
    const created = await recipeStore.create(input);

    expect(postPhoto).toHaveBeenCalledWith(COVER, created.id, created.updatedAt, coverBlob);
    expect(postPhoto).toHaveBeenCalledWith(GALLERY, created.id, created.updatedAt, galleryBlob);
    expect(server.liveRecipeIds).toEqual(new Set([created.id]));
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([created.id]);
    expect(getSnapshot().remotePhotoIds).toEqual(new Set([COVER, GALLERY]));
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('uploads the staged photo when create is retried after a recipe push failure', async () => {
    stagePhotos();
    let pushFailures = 1;
    const server = installPhotoServerFake({
      failPush: () => {
        if (pushFailures > 0) {
          pushFailures -= 1;
          return 'error';
        }
        return undefined;
      },
    });
    const input = { ...draft, photoId: COVER };

    await expect(recipeStore.create(input)).rejects.toThrow(t('error.recipeSave'));
    const created = await recipeStore.create(input);

    expect(server.calls).toEqual([
      'push:recipe.put',
      'push:recipe.delete',
      'push:recipe.put',
      `photo:${COVER}`,
    ]);
    expect(server.liveRecipeIds).toEqual(new Set([created.id]));
    expect(getSnapshot().remotePhotoIds.has(COVER)).toBe(true);
  });

  it('still reports the photo error when the cleanup delete also fails', async () => {
    stagePhotos();
    const server = installPhotoServerFake({
      failPush: (ops) => (ops[0]?.kind === 'recipe.delete' ? 'error' : undefined),
      failPhoto: () => 'error',
    });

    await expect(recipeStore.create({ ...draft, photoId: COVER })).rejects.toThrow(
      t('error.photoSave'),
    );

    expect(server.calls).toEqual(['push:recipe.put', `photo:${COVER}`, 'push:recipe.delete']);
    expect(listRecipes()).toEqual([]);
  });

  it.each([
    ['applies nothing for', 'failPush'],
    ['applies but loses the response to', 'failAfterApply'],
  ] as const)(
    'never shares photo ids with a failed recipe when the server %s recipe.delete',
    async (_label, mode) => {
      stagePhotos();
      const coverBlob = getSnapshot().pendingBlobs.get(COVER);
      let galleryFailures = 1;
      const server = installPhotoServerFake({
        [mode]: (ops: PushOp[]) => (ops[0]?.kind === 'recipe.delete' ? 'error' : undefined),
        failPhoto: (id: string) => {
          if (id === GALLERY && galleryFailures > 0) {
            galleryFailures -= 1;
            return 'error';
          }
          return undefined;
        },
      });
      const input = { ...draft, photoId: COVER, galleryPhotoIds: [GALLERY] };

      const err = await failedCreate(input);
      const retry = draftAfterFailure(input, err);
      const created = await recipeStore.create(retry);

      const [firstId] = putIds(server.pushed);
      const firstStillLive = server.liveRecipeIds.has(firstId);
      expect(mode === 'failPush' ? firstStillLive : !firstStillLive).toBe(true);
      expect(server.liveRecipeIds.has(created.id)).toBe(true);
      expect(created.photoId).not.toBe(COVER);
      expect(created.galleryPhotoIds).not.toContain(GALLERY);
      expect(created.galleryPhotoIds).toHaveLength(1);
      // The same bytes, under the new ids.
      expect(postPhoto).toHaveBeenCalledWith(created.photoId, created.id, created.updatedAt, coverBlob);
      expect(getSnapshot().remotePhotoIds).toEqual(
        new Set([created.photoId, ...(created.galleryPhotoIds ?? [])]),
      );
      expect(getSnapshot().pendingBlobs.size).toBe(0);
    },
  );

  it('refuses a new recipe whose photo id has no staged bytes', async () => {
    const server = installPhotoServerFake();

    await expect(recipeStore.create({ ...draft, photoId: COVER })).rejects.toThrow(
      t('error.photoSave'),
    );

    expect(server.calls).toEqual([]);
    expect(listRecipes()).toEqual([]);
  });

  it('skips the cleanup delete once the photo upload signs the user out', async () => {
    stagePhotos();
    const server = installPhotoServerFake({ failPhoto: () => 'signedOut' });

    await expect(recipeStore.create({ ...draft, photoId: COVER })).rejects.toThrow(
      t('error.sessionExpired'),
    );

    expect(server.calls).toEqual(['push:recipe.put', `photo:${COVER}`]);
    expect(listRecipes()).toEqual([]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('keeps nothing when the recipe push signs the user out', async () => {
    stagePhotos();
    upsertCollection(collection);
    const server = installPhotoServerFake({ failPush: () => 'signedOut' });

    await expect(
      recipeStore.create({ ...draft, photoId: COVER }, { collectionId: COLLECTION_ID }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(postPhoto).not.toHaveBeenCalled();
    expect(server.calls).toEqual(['push:recipe.put', 'push:collection.put']);
    expect(listRecipes()).toEqual([]);
    expect(listCollections()).toEqual([]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('tells sign-out apart by type, not by the text of any locale', async () => {
    vi.spyOn(settings, 'getLocale').mockReturnValue('uk');
    stagePhotos();
    const server = installPhotoServerFake({ failPhoto: () => 'signedOut' });

    await expect(recipeStore.create({ ...draft, photoId: COVER })).rejects.toThrow(
      translate('uk', 'error.sessionExpired'),
    );

    expect(server.calls).toEqual(['push:recipe.put', `photo:${COVER}`]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });
});
