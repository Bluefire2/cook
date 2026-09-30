import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { cookLogStore } from './cookLogStore';
import {
  addPendingBlob,
  clearLibrary,
  getCookLog,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  listCookLogs,
  upsertCookLog,
  upsertRecipe,
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import { installSharedRows } from './testLibrary';
import type { PushOp } from './pushOps';
import type { CookLog } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PHOTO_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PHOTO_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const recipe = {
  id: RECIPE_ID,
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: [],
  notes: 'Serve hot.',
};

const existing: CookLog = {
  id: LOG_ID,
  recipeId: RECIPE_ID,
  cookedOn: '2026-09-20',
  createdAt: 3,
  updatedAt: 4,
  lessons: 'Less salt next time.',
  photoIds: [PHOTO_A, PHOTO_B],
};

function blob(): Blob {
  return new Blob(['x'], { type: 'image/jpeg' });
}

function recordCalls(pushResult: string, photoResult = 'ok'): string[] {
  const calls: string[] = [];
  vi.mocked(postPhoto).mockImplementation(async (id) => {
    calls.push(`postPhoto:${id}`);
    return photoResult as never;
  });
  vi.mocked(pushOps).mockImplementation(async (ops) => {
    calls.push(`push:${ops.map((op) => op.kind).join(',')}`);
    return pushResult as never;
  });
  return calls;
}

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
  vi.mocked(postPhoto).mockReset();
});

describe('cookLogStore.create', () => {
  it('uploads pending photos with the entry recipeId and updatedAt before the put', async () => {
    upsertRecipe(recipe);
    addPendingBlob(PHOTO_A, blob());
    const calls = recordCalls('ok');

    const log = await cookLogStore.create({
      recipeId: RECIPE_ID,
      cookedOn: '2026-09-21',
      rating: 5,
      notes: '  Used leeks.  ',
      lessons: '',
      photoIds: [PHOTO_A],
    });

    expect(calls).toEqual([`postPhoto:${PHOTO_A}`, 'push:cookLog.put']);
    expect(vi.mocked(postPhoto).mock.calls[0]?.slice(0, 3)).toEqual([
      PHOTO_A,
      RECIPE_ID,
      log.updatedAt,
    ]);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] as PushOp[];
    expect(ops).toEqual([{ kind: 'cookLog.put', payload: log }]);
    expect(log.notes).toBe('Used leeks.');
    expect('lessons' in log).toBe(false);
    expect(getCookLog(log.id)).toEqual(log);
    expect(getSnapshot().remotePhotoIds.has(PHOTO_A)).toBe(true);
  });

  it('removes the entry locally and rethrows when the put fails', async () => {
    upsertRecipe(recipe);
    recordCalls('error');

    await expect(
      cookLogStore.create({ recipeId: RECIPE_ID, cookedOn: '2026-09-21' }),
    ).rejects.toThrow("Couldn't save the cook log.");
    expect(listCookLogs()).toEqual([]);
  });

  it('does not push when a photo upload signs out', async () => {
    upsertRecipe(recipe);
    addPendingBlob(PHOTO_A, blob());
    vi.mocked(postPhoto).mockImplementation(async () => {
      clearLibrary();
      return 'signedOut';
    });

    await expect(
      cookLogStore.create({ recipeId: RECIPE_ID, cookedOn: '2026-09-21', photoIds: [PHOTO_A] }),
    ).rejects.toThrow(t('error.sessionExpired'));
    expect(pushOps).not.toHaveBeenCalled();
    expect(listCookLogs()).toEqual([]);
    expect(getRecipe(RECIPE_ID)).toBeUndefined();
  });

  it('refuses an entry for a recipe that is not in the library', async () => {
    recordCalls('ok');

    await expect(
      cookLogStore.create({ recipeId: RECIPE_ID, cookedOn: '2026-09-21' }),
    ).rejects.toThrow('This recipe is no longer in your library.');
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('refuses an entry for a recipe shared with this account', async () => {
    installSharedRows({
      recipes: new Map([[RECIPE_ID, recipe]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([[RECIPE_ID, { kind: 'shared', ownerSub: 'owner-sub' }]]),
      collectionOrigins: new Map(),
    });
    recordCalls('ok');

    await expect(
      cookLogStore.create({ recipeId: RECIPE_ID, cookedOn: '2026-09-21' }),
    ).rejects.toThrow('Cook logs are only for your own recipes.');
    expect(pushOps).not.toHaveBeenCalled();
    expect(listCookLogs()).toEqual([]);
  });
});

describe('cookLogStore.save', () => {
  it('deletes removed photos only after a successful put', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    addPendingBlob(PHOTO_B, blob());
    const calls = recordCalls('ok');

    await cookLogStore.save({ ...existing, photoIds: [PHOTO_A] });

    expect(calls).toEqual(['push:cookLog.put', 'push:photo.delete']);
    const deleteOps = vi.mocked(pushOps).mock.calls[1]?.[0] as PushOp[];
    expect(deleteOps).toMatchObject([{ kind: 'photo.delete', payload: { id: PHOTO_B } }]);
    expect(getPendingBlob(PHOTO_B)).toBeUndefined();
    const saved = getCookLog(LOG_ID);
    expect(saved?.photoIds).toEqual([PHOTO_A]);
    expect(saved!.updatedAt).toBeGreaterThan(existing.updatedAt);
  });

  it('rolls back to the previous entry and keeps its photos when the put fails', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    addPendingBlob(PHOTO_B, blob());
    const calls = recordCalls('invalid');

    await expect(
      cookLogStore.save({ ...existing, photoIds: [PHOTO_A], notes: 'Edited' }),
    ).rejects.toThrow("Couldn't save the cook log.");

    expect(calls).toEqual(['push:cookLog.put']);
    expect(getCookLog(LOG_ID)).toEqual(existing);
    expect(getPendingBlob(PHOTO_B)).toBeDefined();
  });
});

describe('cookLogStore.remove', () => {
  it('pushes one batch with the entry delete first, then its photos', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    addPendingBlob(PHOTO_A, blob());
    recordCalls('ok');

    await cookLogStore.remove(LOG_ID);

    expect(pushOps).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] as PushOp[];
    expect(ops.map((op) => [op.kind, (op.payload as { id: string }).id])).toEqual([
      ['cookLog.delete', LOG_ID],
      ['photo.delete', PHOTO_A],
      ['photo.delete', PHOTO_B],
    ]);
    expect(getCookLog(LOG_ID)).toBeUndefined();
    expect(getPendingBlob(PHOTO_A)).toBeUndefined();
  });

  it('restores the entry and its photos when the batch fails', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    addPendingBlob(PHOTO_A, blob());
    recordCalls('error');

    await expect(cookLogStore.remove(LOG_ID)).rejects.toThrow(
      "Couldn't delete the cook log.",
    );
    expect(getCookLog(LOG_ID)).toEqual(existing);
    expect(getPendingBlob(PHOTO_A)).toBeDefined();
  });
});

describe('cookLogStore after sign-out', () => {
  /** `remote` clears the library before it reports a 401. */
  async function signOut(): Promise<'signedOut'> {
    clearLibrary();
    return 'signedOut';
  }

  it('create does not leave the new entry behind when the put signs out', async () => {
    upsertRecipe(recipe);
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(
      cookLogStore.create({ recipeId: RECIPE_ID, cookedOn: '2026-09-21' }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(listCookLogs()).toEqual([]);
    expect(getRecipe(RECIPE_ID)).toBeUndefined();
  });

  it('save does not restore the old entry when a photo upload signs out', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    const photo = '99999999-9999-4999-8999-999999999999';
    addPendingBlob(photo, blob());
    vi.mocked(postPhoto).mockImplementation(signOut);

    await expect(
      cookLogStore.save({ ...existing, photoIds: [...(existing.photoIds ?? []), photo] }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(pushOps).not.toHaveBeenCalled();
    expect(getCookLog(LOG_ID)).toBeUndefined();
  });

  it('remove does not restore the entry when the delete signs out', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(cookLogStore.remove(LOG_ID)).rejects.toThrow(t('error.sessionExpired'));

    expect(getCookLog(LOG_ID)).toBeUndefined();
    expect(listCookLogs()).toEqual([]);
  });

  it('remove still restores the entry when the delete fails for another reason', async () => {
    upsertRecipe(recipe);
    upsertCookLog(existing);
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(cookLogStore.remove(LOG_ID)).rejects.toThrow(t('error.cookLogDelete'));

    expect(getCookLog(LOG_ID)).toEqual(existing);
  });
});

describe('cookLogStore.promoteLesson', () => {
  it('appends the lesson to the latest recipe notes', async () => {
    upsertRecipe(recipe);
    upsertRecipe({ ...recipe, notes: 'Serve hot with bread.', updatedAt: 5 });
    recordCalls('ok');

    await cookLogStore.promoteLesson(RECIPE_ID, existing);

    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] as PushOp[];
    expect(ops[0]).toMatchObject({
      kind: 'recipe.put',
      payload: { id: RECIPE_ID, notes: 'Serve hot with bread.\n\nLess salt next time.' },
    });
    expect(getRecipe(RECIPE_ID)?.notes).toBe('Serve hot with bread.\n\nLess salt next time.');
  });

  it('is a no-op when the lesson is already in the notes', async () => {
    upsertRecipe({ ...recipe, notes: 'Serve hot.\n\nLess salt next time.' });
    recordCalls('ok');

    await cookLogStore.promoteLesson(RECIPE_ID, existing);

    expect(pushOps).not.toHaveBeenCalled();
  });

  it('is a no-op for an entry without lessons', async () => {
    upsertRecipe(recipe);
    recordCalls('ok');

    await cookLogStore.promoteLesson(RECIPE_ID, { ...existing, lessons: undefined });

    expect(pushOps).not.toHaveBeenCalled();
  });

  it('throws when the recipe is gone', async () => {
    recordCalls('ok');

    await expect(cookLogStore.promoteLesson(RECIPE_ID, existing)).rejects.toThrow(
      'This recipe is no longer in your library.',
    );
    expect(pushOps).not.toHaveBeenCalled();
  });
});
