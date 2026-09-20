import { describe, expect, it } from 'vitest';
import type { Recipe } from './types';
import { visibleLibraryRecipes } from './visibleLibraryRecipes';

const soup: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

const cake: Recipe = {
  id: 'r2',
  createdAt: 1,
  updatedAt: 3,
  title: 'Cake',
  servings: 8,
  ingredientSections: [{ items: [{ item: 'flour' }] }],
  steps: [{ text: 'Bake.' }],
  tags: ['dessert'],
};

describe('visibleLibraryRecipes', () => {
  it('is undefined while either list is loading', () => {
    expect(
      visibleLibraryRecipes({
        all: undefined,
        scoped: [soup],
        query: '',
        browseAll: false,
      }),
    ).toBeUndefined();
  });

  it('uses the scoped list until All collections is on', () => {
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: '',
        browseAll: false,
      }),
    ).toEqual([soup]);
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: '',
        browseAll: true,
      }),
    ).toEqual([soup, cake]);
  });

  it('filters the active source by title or tag', () => {
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: 'cake',
        browseAll: false,
      }),
    ).toEqual([]);
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: 'cake',
        browseAll: true,
      }),
    ).toEqual([cake]);
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup, cake],
        query: 'dessert',
        browseAll: false,
      }),
    ).toEqual([cake]);
  });
});
