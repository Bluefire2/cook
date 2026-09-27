import { afterEach, describe, expect, it, vi } from 'vitest';
import { recipeStore } from './recipeStore';
import {
  addPendingBlob,
  clearLibrary,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  listRecipes,
  upsertRecipe,
} from './libraryMemory';
import { fetchPhotoBlob, postPhoto, pushOps } from './remote';
import { installSharedRows } from './testLibrary';
import type { Recipe, RecipeDraft } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
  fetchPhotoBlob: vi.fn(),
}));

const COVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GALLERY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const draft: RecipeDraft = {
  title: 'Variant',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'salt' }] }],
  steps: [{ text: 'Stir.' }],
  tags: ['dinner'],
};

function parentRecipe(photoId?: string, galleryPhotoIds?: string[]): Recipe {
  return {
    id: PARENT_ID,
    title: 'Original',
    servings: 4,
    ingredientSections: [{ items: [{ item: 'water' }] }],
    steps: [{ text: 'Boil.' }],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    ...(photoId !== undefined ? { photoId } : {}),
    ...(galleryPhotoIds !== undefined ? { galleryPhotoIds } : {}),
  };
}

afterEach(() => {
  clearLibrary();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.mocked(fetchPhotoBlob).mockReset();
});

describe('recipeStore.createFromAsk', () => {
  it('copies the cover and gallery onto new ids and uploads those', async () => {
    const coverBlob = new Blob(['cover'], { type: 'image/jpeg' });
    const galleryBlob = new Blob(['gallery'], { type: 'image/jpeg' });
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    addPendingBlob(COVER, coverBlob);
    vi.mocked(fetchPhotoBlob).mockImplementation(async (id) =>
      id === GALLERY ? galleryBlob : null,
    );
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft);

    expect(created.photoId).toBeDefined();
    expect(created.photoId).not.toBe(COVER);
    expect(created.galleryPhotoIds).toEqual([expect.any(String)]);
    expect(created.galleryPhotoIds?.[0]).not.toBe(GALLERY);
    expect(created.galleryPhotoIds?.[0]).not.toBe(created.photoId);
    expect(fetchPhotoBlob).toHaveBeenCalledTimes(1);
    expect(fetchPhotoBlob).toHaveBeenCalledWith(GALLERY, undefined);
    expect(postPhoto).toHaveBeenCalledWith(
      created.photoId,
      created.id,
      created.updatedAt,
      coverBlob,
    );
    expect(postPhoto).toHaveBeenCalledWith(
      created.galleryPhotoIds?.[0],
      created.id,
      created.updatedAt,
      galleryBlob,
    );
    const pushed = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(pushed?.[0]).toMatchObject({
      kind: 'recipe.put',
      payload: { id: created.id, photoId: created.photoId, galleryPhotoIds: created.galleryPhotoIds },
    });
  });

  it('fetches a shared parent photo with the owner sub', async () => {
    const parent = parentRecipe(COVER, [GALLERY]);
    installSharedRows({
      recipes: new Map([[parent.id, parent]]),
      collections: new Map(),
      remotePhotoIds: new Set([COVER, GALLERY]),
      recipeOrigins: new Map([[parent.id, { kind: 'shared', ownerSub: 'owner-1' }]]),
      collectionOrigins: new Map(),
    });
    vi.mocked(fetchPhotoBlob).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.createFromAsk(parent, draft);

    expect(fetchPhotoBlob).toHaveBeenCalledWith(COVER, 'owner-1');
    expect(fetchPhotoBlob).toHaveBeenCalledWith(GALLERY, 'owner-1');
  });

  it('omits a photo that could not be copied and still saves the recipe', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlob).mockImplementation(async (id) =>
      id === COVER ? new Blob(['cover'], { type: 'image/jpeg' }) : null,
    );
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft);

    expect(created.photoId).toBeDefined();
    expect(created.galleryPhotoIds).toBeUndefined();
    expect(getRecipe(created.id)?.photoId).toBe(created.photoId);
  });

  it('creates nothing when the photo fetch signs the user out', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlob).mockImplementation(async (id) =>
      id === COVER ? new Blob(['cover'], { type: 'image/jpeg' }) : 'signedOut',
    );

    await expect(recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft)).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([PARENT_ID]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('ignores a photo id on the proposal', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlob).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), {
      ...draft,
      photoId: 'hallucinated-cover',
      galleryPhotoIds: ['hallucinated-gallery'],
    });

    expect(created.photoId).not.toBe('hallucinated-cover');
    expect(created.photoId).not.toBe(COVER);
    expect(created.galleryPhotoIds).not.toContain('hallucinated-gallery');
    expect(created.galleryPhotoIds).not.toContain(GALLERY);
    expect(getPendingBlob(COVER)).toBeUndefined();
  });
});
