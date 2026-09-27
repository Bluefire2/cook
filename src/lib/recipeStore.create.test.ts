import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { recipeStore } from './recipeStore';
import {
  addPendingBlob,
  clearLibrary,
  getCollection,
  getRecipe,
  getSnapshot,
  listRecipes,
  upsertCollection,
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import { installPhotoServerFake } from './testPhotoServer';
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

afterEach(() => {
  clearLibrary();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
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

  it('uploads nothing when the recipe push fails', async () => {
    stagePhotos();
    upsertCollection(collection);
    const server = installPhotoServerFake({ failPush: () => 'error' });

    await expect(
      recipeStore.create(
        { ...draft, photoId: COVER, galleryPhotoIds: [GALLERY] },
        { collectionId: COLLECTION_ID },
      ),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(postPhoto).not.toHaveBeenCalled();
    expect(server.calls).toEqual(['push:recipe.put', 'push:collection.put']);
    expect(listRecipes()).toEqual([]);
    expect(getCollection(COLLECTION_ID)).toEqual(collection);
    expect([...getSnapshot().pendingBlobs.keys()].sort()).toEqual([COVER, GALLERY]);
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

    expect(server.calls).toEqual(['push:recipe.put', 'push:recipe.put', `photo:${COVER}`]);
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
    installPhotoServerFake({ failPush: () => 'signedOut' });

    await expect(recipeStore.create({ ...draft, photoId: COVER })).rejects.toThrow(
      t('error.sessionExpired'),
    );

    expect(postPhoto).not.toHaveBeenCalled();
    expect(listRecipes()).toEqual([]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });
});
