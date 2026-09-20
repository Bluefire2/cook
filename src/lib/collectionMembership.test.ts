import { describe, expect, it } from 'vitest';
import {
  moveRecipe,
  recipesInCollection,
  unfiledRecipes,
  winningMembership,
  wouldExceedRecipeIdCap,
} from './collectionMembership';
import { MAX_COLLECTION_RECIPE_IDS } from './compactCollection';
import type { Collection, Recipe } from './types';

const r1: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 1,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: [],
};
const r2: Recipe = { ...r1, id: 'r2', title: 'Stew' };
const r3: Recipe = { ...r1, id: 'r3', title: 'Pie' };

const dinners: Collection = {
  id: 'c-b',
  name: 'Dinners',
  recipeIds: ['r1', 'r2'],
  createdAt: 1,
  updatedAt: 2,
};
const lunches: Collection = {
  id: 'c-a',
  name: 'Lunches',
  recipeIds: ['r1'],
  createdAt: 1,
  updatedAt: 2,
};

describe('winningMembership', () => {
  it('gives a recipe listed twice to the lexicographically smallest collection id', () => {
    const map = winningMembership([dinners, lunches]);
    expect(map.get('r1')).toBe('c-a');
    expect(map.get('r2')).toBe('c-b');
  });
});

describe('unfiledRecipes', () => {
  it('returns recipes not claimed by any live named collection', () => {
    expect(unfiledRecipes([r1, r2, r3], [dinners]).map((r) => r.id)).toEqual(['r3']);
  });
});

describe('recipesInCollection', () => {
  it('skips unknown ids and ids that belong to another collection', () => {
    const all = [dinners, lunches];
    expect(recipesInCollection([r1, r2, r3], dinners, all).map((r) => r.id)).toEqual(
      ['r2'],
    );
    expect(recipesInCollection([r1, r2, r3], lunches, all).map((r) => r.id)).toEqual(
      ['r1'],
    );
  });
  it('preserves library order instead of membership insertion order', () => {
    const newest = { ...r2, updatedAt: 10 };
    expect(recipesInCollection([newest, r1, r3], dinners, [dinners])).toEqual([newest, r1]);
  });
});

describe('moveRecipe', () => {
  it('removes from source and appends to dest', () => {
    const changed = moveRecipe([dinners, lunches], 'r2', 'c-a', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: ['r1'], updatedAt: 9 },
      { ...lunches, recipeIds: ['r1', 'r2'], updatedAt: 9 },
    ]);
  });

  it('moving to default only strips named membership', () => {
    const changed = moveRecipe([dinners], 'r1', 'default', 9);
    expect(changed).toEqual([{ ...dinners, recipeIds: ['r2'], updatedAt: 9 }]);
  });
});

describe('wouldExceedRecipeIdCap', () => {
  it('allows the limit and rejects an additional recipe', () => {
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `recipe-${i}`);
    expect(wouldExceedRecipeIdCap(ids)).toBe(false);
    expect(wouldExceedRecipeIdCap([...ids, 'extra'])).toBe(true);
  });
});
