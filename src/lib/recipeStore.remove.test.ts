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
import { localWriteOverlapsPull, pullAfterLocalWrite } from './syncEngine';
import type { PushOp } from './pushOps';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

vi.mock('./syncEngine', () => ({
  localWriteOverlapsPull: vi.fn(() => false),
  pullAfterLocalWrite: vi.fn(),
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
  vi.mocked(localWriteOverlapsPull).mockReset();
  vi.mocked(localWriteOverlapsPull).mockReturnValue(false);
  vi.mocked(pullAfterLocalWrite).mockReset();
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
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('pulls again when a refresh overlapped the delete', async () => {
    upsertRecipe(recipe);
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(localWriteOverlapsPull).mockReturnValue(true);
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('ok');

    await recipeStore.remove(RECIPE_ID);

    expect(getRecipe(RECIPE_ID)).toBeUndefined();
    expect(pullAfterLocalWrite).toHaveBeenCalledOnce();
  });

  it('leaves the recipe deleted when the push fails after the server already removed it', async () => {
    upsertRecipe(recipe);
    upsertCollection(collection);
    vi.mocked(pushOps).mockResolvedValue('error');
    vi.mocked(pullAfterLocalWrite).mockImplementation(async () => {
      clearLibrary();
      return 'ok';
    });

    await recipeStore.remove(RECIPE_ID);

    expect(getRecipe(RECIPE_ID)).toBeUndefined();
    expect(pullAfterLocalWrite).toHaveBeenCalledOnce();
  });

  it('restores the recipe when the push fails and the server still has it', async () => {
    upsertRecipe(recipe);
    upsertCollection(collection);
    vi.mocked(pushOps).mockResolvedValue('error');
    vi.mocked(pullAfterLocalWrite).mockImplementation(async () => {
      upsertRecipe(recipe);
      upsertCollection(collection);
      return 'ok';
    });

    await expect(recipeStore.remove(RECIPE_ID)).rejects.toThrow(
      "Couldn't delete the recipe.",
    );
    expect(getRecipe(RECIPE_ID)).toEqual(recipe);
    expect(getCollection(COLLECTION_ID)).toEqual(collection);
  });

  it('restores the recipe and collection when the push and the follow-up pull both fail', async () => {
    upsertRecipe(recipe);
    upsertCollection(collection);
    vi.mocked(pushOps).mockResolvedValue('error');
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('error');

    await expect(recipeStore.remove(RECIPE_ID)).rejects.toThrow(
      "Couldn't delete the recipe.",
    );
    expect(getRecipe(RECIPE_ID)).toEqual(recipe);
    expect(getCollection(COLLECTION_ID)).toEqual(collection);
  });
});
