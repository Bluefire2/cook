import { describe, expect, it } from 'vitest';
import {
  MAX_COLLECTION_RECIPE_IDS,
  compactCollection,
  compactCollectionName,
  uniqueRecipeIds,
} from './compactCollection';
import type { Collection } from './types';

const required: Collection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Dinners',
  recipeIds: ['22222222-2222-4222-8222-222222222222'],
  createdAt: 1,
  updatedAt: 2,
};

describe('uniqueRecipeIds', () => {
  it('drops blanks and duplicates while keeping order', () => {
    expect(uniqueRecipeIds(['a', '', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('caps at MAX_COLLECTION_RECIPE_IDS', () => {
    const ids = Array.from(
      { length: MAX_COLLECTION_RECIPE_IDS + 3 },
      (_, i) => `id-${i}`,
    );
    expect(uniqueRecipeIds(ids)).toHaveLength(MAX_COLLECTION_RECIPE_IDS);
  });

  it('returns [] for non-arrays', () => {
    expect(uniqueRecipeIds(undefined)).toEqual([]);
  });
});

describe('compactCollectionName', () => {
  it('trims and rejects empty or overlong names', () => {
    expect(compactCollectionName('  Dinners  ')).toBe('Dinners');
    expect(compactCollectionName('   ')).toBeUndefined();
    expect(compactCollectionName('x'.repeat(81))).toBeUndefined();
  });
});

describe('compactCollection', () => {
  it('trims the name and unique-ifies recipeIds', () => {
    const compacted = compactCollection({
      ...required,
      name: '  Dinners  ',
      recipeIds: ['a', 'a', 'b'],
    });
    expect(compacted.name).toBe('Dinners');
    expect(compacted.recipeIds).toEqual(['a', 'b']);
    expect(Object.keys(compacted).sort()).toEqual(
      ['createdAt', 'id', 'name', 'recipeIds', 'updatedAt'].sort(),
    );
  });
});
