import { describe, expect, it } from 'vitest';
import {
  moveRecipe,
  moveRecipes,
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

describe('moveRecipes', () => {
  it('removes ids from every source and appends them to the destination', () => {
    const desserts: Collection = {
      id: 'c-d',
      name: 'Desserts',
      recipeIds: ['r3'],
      createdAt: 1,
      updatedAt: 2,
    };
    const changed = moveRecipes([dinners, lunches, desserts], ['r1', 'r2'], 'c-d', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: [], updatedAt: 9 },
      { ...lunches, recipeIds: [], updatedAt: 9 },
      { ...desserts, recipeIds: ['r3', 'r1', 'r2'], updatedAt: 9 },
    ]);
  });

  it('does not duplicate ids already on the destination', () => {
    const changed = moveRecipes([dinners], ['r2'], 'c-b', 9);
    expect(changed).toEqual([]);
  });

  it('removes a doubly-listed id from the non-destination collection', () => {
    const changed = moveRecipes([dinners, lunches], ['r1'], 'c-b', 9);
    expect(changed.find((c) => c.id === 'c-a')?.recipeIds).toEqual([]);
    const dest = changed.find((c) => c.id === 'c-b');
    expect(dest?.recipeIds.filter((id) => id === 'r1')).toHaveLength(1);
    const applied = [dinners, lunches].map((c) => changed.find((x) => x.id === c.id) ?? c);
    expect(winningMembership(applied).get('r1')).toBe('c-b');
  });

  it('moving to default only strips named membership', () => {
    const changed = moveRecipes([dinners, lunches], ['r1', 'r2'], 'default', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: [], updatedAt: 9 },
      { ...lunches, recipeIds: [], updatedAt: 9 },
    ]);
  });

  it('appends 500 ids to an empty destination without truncating', () => {
    const empty: Collection = { id: 'c-empty', name: 'Empty', recipeIds: [], createdAt: 1, updatedAt: 2 };
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `recipe-${i}`);
    const changed = moveRecipes([empty], ids, 'c-empty', 9);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.recipeIds).toHaveLength(MAX_COLLECTION_RECIPE_IDS);
    expect(changed[0]?.recipeIds[0]).toBe('recipe-0');
    expect(changed[0]?.recipeIds[MAX_COLLECTION_RECIPE_IDS - 1]).toBe(
      `recipe-${MAX_COLLECTION_RECIPE_IDS - 1}`,
    );
  });

  it('does not silently truncate when more than 500 ids are appended', () => {
    const empty: Collection = { id: 'c-empty', name: 'Empty', recipeIds: [], createdAt: 1, updatedAt: 2 };
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS + 1 }, (_, i) => `recipe-${i}`);
    const changed = moveRecipes([empty], ids, 'c-empty', 9);
    expect(changed[0]?.recipeIds).toHaveLength(MAX_COLLECTION_RECIPE_IDS + 1);
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
