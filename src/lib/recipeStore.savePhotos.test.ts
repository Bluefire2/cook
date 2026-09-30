import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { recipeStore, resetRecipePhotoSaveTracking } from './recipeStore';
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

function deletePushes(): PushOp[][] {
  return vi
    .mocked(pushOps)
    .mock.calls.map(([ops]) => ops)
    .filter((ops) => ops.some((op) => op.kind === 'photo.delete'));
}

afterEach(() => {
  clearLibrary();
  resetRecipePhotoSaveTracking();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
});

describe('recipeStore.save photo cleanup', () => {
  it('tombstones each photo uploaded before a put the server discarded', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockImplementation(async (ops) =>
      ops.some((op) => op.kind === 'recipe.put') ? 'invalid' : 'ok',
    );

    await expect(
      recipeStore.save({
        ...storedRecipe(),
        title: 'Failed edit',
        photoId: NEW_COVER,
        galleryPhotoIds: [NEW_GALLERY],
      }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(deletePushes()).toHaveLength(1);
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
    // The gallery POST reported failure. Its id was recorded first, so a
    // response lost after the bytes landed is still tombstoned.
    expect(deletePushes()).toHaveLength(1);
    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: NEW_COVER, updatedAt: expect.any(Number) } },
      { kind: 'photo.delete', payload: { id: NEW_GALLERY, updatedAt: expect.any(Number) } },
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
      if (ops.some((op) => op.kind === 'recipe.put')) return 'invalid';
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
      ops.some((op) => op.kind === 'recipe.put') ? 'invalid' : 'ok',
    );

    await expect(
      recipeStore.save({
        ...storedRecipe(),
        title: 'Failed edit',
        galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
      }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(postPhoto).not.toHaveBeenCalledWith(
      OLD_COVER,
      RECIPE_ID,
      expect.any(Number),
      expect.any(Blob),
    );
    expect(postPhoto).toHaveBeenCalledTimes(1);
    expect(photoDeletes().map((op) => (op.kind === 'photo.delete' ? op.payload.id : ''))).toEqual([
      NEW_GALLERY,
    ]);
    expect(getSnapshot().remotePhotoIds.has(OLD_COVER)).toBe(true);
  });

  it('keeps photos uploaded before a put whose outcome is unknown', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    // 'error' is also a dropped response after the server stored the put.
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(
      recipeStore.save({ ...storedRecipe(), title: 'Maybe landed', photoId: NEW_COVER }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(photoDeletes()).toEqual([]);
    expect(getRecipe(RECIPE_ID)?.title).toBe('Soup');
  });

  it('does not tombstone or restore anything after a signed-out put', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    // `remote` clears the library before it reports a 401.
    vi.mocked(pushOps).mockImplementation(async () => {
      clearLibrary();
      return 'signedOut';
    });

    await expect(
      recipeStore.save({ ...storedRecipe(), photoId: NEW_COVER }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(photoDeletes()).toEqual([]);
    expect(getRecipe(RECIPE_ID)).toBeUndefined();
    expect(getSnapshot().recipes.size).toBe(0);
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

  it('tombstones a new photo when its upload reports failure', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    vi.mocked(postPhoto).mockResolvedValue('error');
    vi.mocked(pushOps).mockResolvedValue('ok');

    await expect(
      recipeStore.save({ ...storedRecipe(), photoId: NEW_COVER }),
    ).rejects.toThrow(t('error.photoSave'));

    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: NEW_COVER, updatedAt: expect.any(Number) } },
    ]);
    expect(vi.mocked(pushOps).mock.calls.some(([ops]) => ops.some((op) => op.kind === 'recipe.put'))).toBe(
      false,
    );
  });

  it('resolves when a removed-photo delete throws after the put lands', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    vi.mocked(pushOps).mockImplementation(async (ops) => {
      if (ops.some((op) => op.kind === 'photo.delete')) {
        throw new Error('delete blew up');
      }
      return 'ok';
    });

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
  });

  it('does not tombstone a photo a concurrent save already committed', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');
    let puts = 0;
    vi.mocked(pushOps).mockImplementation(async (ops) => {
      if (!ops.some((op) => op.kind === 'recipe.put')) {
        return 'ok';
      }
      puts += 1;
      if (puts === 1) {
        const current = getRecipe(RECIPE_ID);
        await recipeStore.save({ ...current!, title: 'Lesson' });
        return 'invalid';
      }
      return 'ok';
    });

    await expect(
      recipeStore.save({
        ...storedRecipe(),
        title: 'Failed edit',
        galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
      }),
    ).rejects.toThrow(t('error.recipeSave'));

    expect(photoDeletes()).toEqual([]);
    expect(getRecipe(RECIPE_ID)).toMatchObject({
      title: 'Lesson',
      photoId: OLD_COVER,
      galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
    });
    expect(getSnapshot().remotePhotoIds.has(NEW_GALLERY)).toBe(true);
  });

  it('tombstones a photo once when two overlapping saves both fail', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');

    let releaseSecondPut: () => void = () => {};
    const secondPutGate = new Promise<void>((resolve) => {
      releaseSecondPut = resolve;
    });
    let markSecondPutStarted: () => void = () => {};
    const secondPutStarted = new Promise<void>((resolve) => {
      markSecondPutStarted = resolve;
    });

    const secondSaves: Promise<void>[] = [];
    let puts = 0;
    vi.mocked(pushOps).mockImplementation(async (ops) => {
      if (ops.some((op) => op.kind === 'photo.delete')) {
        return 'ok';
      }
      puts += 1;
      if (puts === 1) {
        const current = getRecipe(RECIPE_ID);
        secondSaves.push(
          recipeStore.save({
            ...current!,
            title: 'Second',
            galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
          }),
        );
        await secondPutStarted;
        return 'invalid';
      }
      markSecondPutStarted();
      await secondPutGate;
      return 'invalid';
    });

    const first = recipeStore.save({
      ...storedRecipe(),
      title: 'First',
      galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
    });
    // The first save fails and releases while the second is still inside its
    // put, so only the second — the last holder — can tombstone the upload.
    await expect(first).rejects.toThrow(t('error.recipeSave'));
    releaseSecondPut();
    await expect(secondSaves[0]).rejects.toThrow(t('error.recipeSave'));

    expect(postPhoto).toHaveBeenCalledTimes(1);
    expect(photoDeletes()).toEqual([
      { kind: 'photo.delete', payload: { id: NEW_GALLERY, updatedAt: expect.any(Number) } },
    ]);
  });

  it('does not tombstone a photo a sibling save may have committed', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_GALLERY, jpeg('gallery'));
    vi.mocked(postPhoto).mockResolvedValue('ok');

    let releaseSecondPut: () => void = () => {};
    const secondPutGate = new Promise<void>((resolve) => {
      releaseSecondPut = resolve;
    });
    let markSecondPutStarted: () => void = () => {};
    const secondPutStarted = new Promise<void>((resolve) => {
      markSecondPutStarted = resolve;
    });

    const secondSaves: Promise<void>[] = [];
    let puts = 0;
    vi.mocked(pushOps).mockImplementation(async (ops) => {
      if (ops.some((op) => op.kind === 'photo.delete')) {
        return 'ok';
      }
      puts += 1;
      if (puts === 1) {
        const current = getRecipe(RECIPE_ID);
        secondSaves.push(
          recipeStore.save({
            ...current!,
            title: 'Second',
            galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
          }),
        );
        await secondPutStarted;
        return 'invalid';
      }
      markSecondPutStarted();
      await secondPutGate;
      return 'error';
    });

    const first = recipeStore.save({
      ...storedRecipe(),
      title: 'First',
      galleryPhotoIds: [OLD_GALLERY, NEW_GALLERY],
    });
    await expect(first).rejects.toThrow(t('error.recipeSave'));
    releaseSecondPut();
    await expect(secondSaves[0]).rejects.toThrow(t('error.recipeSave'));
    expect(photoDeletes()).toEqual([]);

    vi.mocked(pushOps).mockResolvedValue('invalid');
    await expect(
      recipeStore.save({ ...getRecipe(RECIPE_ID)!, title: 'Third' }),
    ).rejects.toThrow(t('error.recipeSave'));
    expect(photoDeletes()).toEqual([]);
    expect(getSnapshot().remotePhotoIds.has(NEW_GALLERY)).toBe(true);
  });

  it('does not tombstone when the upload signs the user out', async () => {
    upsertRecipe(storedRecipe());
    addPendingBlob(NEW_COVER, jpeg('cover'));
    vi.mocked(postPhoto).mockImplementation(async () => {
      clearLibrary();
      return 'signedOut';
    });

    await expect(
      recipeStore.save({ ...storedRecipe(), photoId: NEW_COVER }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(pushOps).not.toHaveBeenCalled();
    expect(getRecipe(RECIPE_ID)).toBeUndefined();
  });
});
