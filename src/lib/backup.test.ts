import { afterEach, describe, expect, it, vi } from 'vitest';
import { importLibrary } from './backup';
import { clearLibrary, listCollections, listRecipes } from './libraryMemory';
import { pushOps } from './remote';

vi.mock('./remote', () => ({
  fetchPhotoBlob: vi.fn(),
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

const RECIPE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

const COLLECTION = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Dinners',
  recipeIds: [RECIPE.id],
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
});

describe('importLibrary', () => {
  it('rolls back local upserts when pushOps rejects', async () => {
    vi.mocked(pushOps).mockResolvedValue('error');
    const file = new File(
      [
        JSON.stringify({
          app: 'cook',
          version: 3,
          exportedAt: 3,
          recipes: [RECIPE],
          chatMessages: [],
          photos: [],
          collections: [COLLECTION],
        }),
      ],
      'cook-backup.json',
      { type: 'application/json' },
    );

    await expect(importLibrary(file, 'test-sub')).rejects.toThrow("Couldn't import the backup.");
    expect(listRecipes()).toEqual([]);
    expect(listCollections()).toEqual([]);
  });
});
