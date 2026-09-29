import { afterEach, describe, expect, it, vi } from 'vitest';
import { recipeStore } from './recipeStore';
import { addPendingBlob, clearLibrary, getRecipe, getSnapshot, upsertRecipe } from './libraryMemory';
import { fetchPhotoBlobOutcome, postPhoto, pushOps } from './remote';
import { installPhotoServerFake } from './testPhotoServer';
import type { Recipe, RecipeDraft } from './types';

// The server stores a photo only under a live recipe (`runUploadIntent` in
// server/photos.ts answers 409 `recipe-deleted` otherwise). These tests run
// the store against a fake that enforces that rule, so a create that uploads
// photos before its recipe exists fails here the way it fails in production.

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
  fetchPhotoBlobOutcome: vi.fn(),
}));

const COVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GALLERY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const draft: RecipeDraft = {
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: [],
};

afterEach(() => {
  clearLibrary();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.mocked(fetchPhotoBlobOutcome).mockReset();
});

describe('creating a recipe with photos against the server upload rule', () => {
  it('creates a recipe with a cover and a gallery photo', async () => {
    addPendingBlob(COVER, new Blob(['cover'], { type: 'image/jpeg' }));
    addPendingBlob(GALLERY, new Blob(['gallery'], { type: 'image/jpeg' }));
    const server = installPhotoServerFake();

    const created = await recipeStore.create({
      ...draft,
      photoId: COVER,
      galleryPhotoIds: [GALLERY],
    });

    expect(getRecipe(created.id)).toMatchObject({ photoId: COVER, galleryPhotoIds: [GALLERY] });
    expect(getSnapshot().remotePhotoIds).toEqual(new Set([COVER, GALLERY]));
    expect(server.liveRecipeIds.has(created.id)).toBe(true);
    expect(vi.mocked(postPhoto).mock.calls.map(([photoId, recipeId]) => [photoId, recipeId])).toEqual(
      expect.arrayContaining([
        [COVER, created.id],
        [GALLERY, created.id],
      ]),
    );
  });

  it('saves an Ask variant of a recipe with photos', async () => {
    const parent: Recipe = {
      ...draft,
      id: PARENT_ID,
      title: 'Original',
      photoId: COVER,
      createdAt: 1,
      updatedAt: 2,
    };
    upsertRecipe(parent);
    addPendingBlob(COVER, new Blob(['cover'], { type: 'image/jpeg' }));
    const server = installPhotoServerFake();

    const created = await recipeStore.createFromAsk(parent, { ...draft, title: 'Variant' });

    expect(created.photoId).toBeDefined();
    expect(created.photoId).not.toBe(COVER);
    expect(getRecipe(created.id)?.photoId).toBe(created.photoId);
    expect(getSnapshot().remotePhotoIds.has(created.photoId as string)).toBe(true);
    expect(server.liveRecipeIds.has(created.id)).toBe(true);
  });
});
