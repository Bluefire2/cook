import { describe, expect, it } from 'vitest';
import { compactRecipe } from './recipeStore';
import type { Recipe } from './types';

const required: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

describe('compactRecipe', () => {
  it('omits optional keys that are undefined', () => {
    const compacted = compactRecipe({
      ...required,
      description: undefined,
      sourceUrl: undefined,
      prepMinutes: undefined,
      cookMinutes: undefined,
      notes: undefined,
      photoId: undefined,
    });

    expect(compacted).toEqual(required);
    expect(Object.keys(compacted).sort()).toEqual(
      [
        'createdAt',
        'id',
        'ingredientSections',
        'servings',
        'steps',
        'tags',
        'title',
        'updatedAt',
      ].sort(),
    );
  });

  it('keeps optional keys that are present', () => {
    const compacted = compactRecipe({
      ...required,
      description: 'Hot.',
      sourceUrl: 'https://example.com/soup',
      prepMinutes: 5,
      cookMinutes: 20,
      notes: 'Salt late.',
      photoId: 'p1',
    });

    expect(compacted.description).toBe('Hot.');
    expect(compacted.sourceUrl).toBe('https://example.com/soup');
    expect(compacted.prepMinutes).toBe(5);
    expect(compacted.cookMinutes).toBe(20);
    expect(compacted.notes).toBe('Salt late.');
    expect(compacted.photoId).toBe('p1');
  });
});
