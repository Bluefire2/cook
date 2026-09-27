import { afterEach, describe, expect, it, vi } from 'vitest';
import { recipeStore } from './recipeStore';
import {
  addPendingBlob,
  clearLibrary,
  getCollection,
  getPendingBlob,
  getRecipe,
  listCookLogs,
  upsertCollection,
  upsertCookLog,
  upsertRecipe,
} from './libraryMemory';
import { pushOps } from './remote';
import type { PushOp } from './pushOps';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLLECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_RECIPE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PHOTO_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const recipe = {
  id: RECIPE_ID,
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

const collection = {
  id: COLLECTION_ID,
  name: 'Dinners',
  recipeIds: [RECIPE_ID],
  createdAt: 1,
  updatedAt: 2,
};

const cookLog = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  recipeId: RECIPE_ID,
  cookedOn: '2026-09-20',
  lessons: 'Less salt.',
  photoIds: [PHOTO_ID],
  createdAt: 3,
  updatedAt: 4,
};

const otherCookLog = {
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  recipeId: OTHER_RECIPE_ID,
  cookedOn: '2026-09-21',
  createdAt: 5,
  updatedAt: 6,
};

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
});

describe('recipeStore.remove', () => {
  it('scrubs the recipe id from collections and pushes both ops', async () => {
    upsertRecipe(recipe);
    upsertCollection(collection);
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.remove(RECIPE_ID);

    expect(getRecipe(RECIPE_ID)).toBeUndefined();
    expect(getCollection(COLLECTION_ID)?.recipeIds).toEqual([]);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] as PushOp[];
    expect(ops[0]).toMatchObject({
      kind: 'recipe.delete',
      payload: { id: RECIPE_ID },
    });
    expect(ops[1]).toMatchObject({
      kind: 'collection.put',
      payload: { id: COLLECTION_ID, recipeIds: [] },
    });
  });

  it('restores the recipe and collection when pushOps fails', async () => {
    upsertRecipe(recipe);
    upsertCollection(collection);
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(recipeStore.remove(RECIPE_ID)).rejects.toThrow(
      "Couldn't delete the recipe.",
    );
    expect(getRecipe(RECIPE_ID)).toEqual(recipe);
    expect(getCollection(COLLECTION_ID)).toEqual(collection);
  });

  it("drops the recipe's cook logs and their photos, and only those", async () => {
    upsertRecipe(recipe);
    upsertCookLog(cookLog);
    upsertCookLog(otherCookLog);
    addPendingBlob(PHOTO_ID, new Blob(['x'], { type: 'image/jpeg' }));
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.remove(RECIPE_ID);

    expect(listCookLogs(RECIPE_ID)).toEqual([]);
    expect(listCookLogs()).toEqual([otherCookLog]);
    expect(getPendingBlob(PHOTO_ID)).toBeUndefined();
  });

  it('re-upserts the recipe cook logs when the delete fails', async () => {
    upsertRecipe(recipe);
    upsertCookLog(cookLog);
    upsertCookLog(otherCookLog);
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(recipeStore.remove(RECIPE_ID)).rejects.toThrow(
      "Couldn't delete the recipe.",
    );
    expect(getRecipe(RECIPE_ID)).toEqual(recipe);
    expect(listCookLogs(RECIPE_ID)).toEqual([cookLog]);
    expect(listCookLogs(OTHER_RECIPE_ID)).toEqual([otherCookLog]);
  });
});
