import { afterEach, describe, expect, it, vi } from 'vitest';
import { recipeStore } from './recipeStore';
import {
  clearLibrary,
  getCollection,
  getRecipe,
  upsertCollection,
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
});
