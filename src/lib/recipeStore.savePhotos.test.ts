import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { recipeStore } from './recipeStore';
import {
  addPendingBlob,
  cachePhotoBlob,
  clearLibrary,
  getRecipe,
  getSnapshot,
  upsertRecipe,
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import type { PushOp } from './pushOps';
import type { Recipe } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
  fetchPhotoBlobOutcome: vi.fn(),
}));

const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const OLD_COVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_GALLERY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_COVER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_GALLERY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function jpeg(label: string): Blob {
  return new Blob([label], { type: 'image/jpeg' });
}

function storedRecipe(): Recipe {
  return {
    id: RECIPE_ID,
    createdAt: 1,
    updatedAt: 2,
    title: 'Soup',
    servings: 2,
    ingredientSections: [{ items: [{ item: 'water' }] }],
    steps: [{ text: 'Boil.' }],
    tags: [],
    photoId: OLD_COVER,
    galleryPhotoIds: [OLD_GALLERY],
  };
}

function photoDeletes(): PushOp[] {
  return vi
    .mocked(pushOps)
    .mock.calls.flatMap(([ops]) => ops)
    .filter((op) => op.kind === 'photo.delete');
}

afterEach(() => {
  clearLibrary();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
});

describe('recipeStore.save photo cleanup', () => {
  it('tombstones each photo uploaded before a failed recipe put', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockImplementation(async (ops) =>
      ops.some((op) => op.kind === 'recipe.put') ? 'error' : 'ok',
    );

    await expect(
      recipeStore.save({
        ...storedRecipe(),
        title: 'Failed edit',
        photoId: NEW_COVER,
        galleryPhotoIds: [NEW_GALLERY],
      }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: NEW_COVER, updatedAt: expect.any(Number) } },
      { kind: 'photo.delete', payload: { id: NEW_GALLERY, updatedAt: expect.any(Number) } },
    ]);
    expect(getRecipe(RECIPE_ID)).toMatchObject({
      title: 'Soup',
      photoId: OLD_COVER,
      galleryPhotoIds: [OLD_GALLERY],
    });
    expect(getSnapshot().remotePhotoIds.has(NEW_COVER)).toBe(false);
    expect(getSnapshot().remotePhotoIds.has(NEW_GALLERY)).toBe(false);
  });

  it('tombstones a photo that uploaded before a later upload failed', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockImplementation(async (id) => (id === NEW_GALLERY ? 'error' : 'ok'));
    vi.mocked(pushOps).mockResolvedValue('ok');

    await expect(
      recipeStore.save({
        ...storedRecipe(),
        photoId: NEW_COVER,
        galleryPhotoIds: [NEW_GALLERY],
      }),
    ).rejects.toThrow(t('error.photoSave'));

    expect(postPhoto).toHaveBeenCalledTimes(2);
    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: NEW_COVER, updatedAt: expect.any(Number) } },
    ]);
    expect(vi.mocked(pushOps).mock.calls.some(([ops]) => ops.some((op) => op.kind === 'recipe.put'))).toBe(
      false,
    );
    expect(getRecipe(RECIPE_ID)?.title).toBe('Soup');
  });

  it('still reports the save error when the photo delete fails', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockImplementation(async (ops) => {
      if (ops.some((op) => op.kind === 'recipe.put')) return 'error';
      throw new Error('delete blew up');
    });

    await expect(
      recipeStore.save({ ...storedRecipe(), title: 'Failed edit', photoId: NEW_COVER }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: NEW_COVER, updatedAt: expect.any(Number) } },
    ]);
    expect(getSnapshot().remotePhotoIds.has(NEW_COVER)).toBe(true);
  });

  it('does not tombstone a photo that was already remote', async () => {
    upsertRecipe(storedRecipe());
    cachePhotoBlob(OLD_COVER, jpeg('old-cover'));
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockImplementation(async (ops) =>
      ops.some((op) => op.kind === 'recipe.put') ? 'error' : 'ok',
    );

    await expect(
      recipeStore.save({
        ...storedRecipe(),
        title: 'Failed edit',
        galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
      }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(postPhoto).toHaveBeenCalledWith(OLD_COVER, RECIPE_ID, expect.any(Number), expect.any(Blob));
    expect(photoDeletes().map((op) => (op.kind === 'photo.delete' ? op.payload.id : ''))).toEqual([
      NEW_GALLERY,
    ]);
    expect(getSnapshot().remotePhotoIds.has(OLD_COVER)).toBe(true);
  });

  it('does not tombstone photos uploaded before a signed-out put', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockResolvedValue('signedOut');

    await expect(
      recipeStore.save({ ...storedRecipe(), photoId: NEW_COVER }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(photoDeletes()).toEqual([]);
  });

  it('tombstones a removed photo after a save that lands, and keeps the new one', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.save({
      ...storedRecipe(),
      title: 'Landed',
      galleryPhotoIds: [NEW_GALLERY],
    });

    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: OLD_GALLERY, updatedAt: expect.any(Number) } },
    ]);
    expect(getRecipe(RECIPE_ID)).toMatchObject({
      title: 'Landed',
      photoId: OLD_COVER,
      galleryPhotoIds: [NEW_GALLERY],
    });
    expect(getSnapshot().remotePhotoIds.has(NEW_GALLERY)).toBe(true);
  });
});
