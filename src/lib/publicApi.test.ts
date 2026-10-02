import { describe, expect, it } from 'vitest';
import { parsePublicCollection, publicPhotoUrl } from './publicApi';

const recipe = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'salt' }] }],
  steps: [{ text: 'Cook.' }],
  tags: [],
  createdAt: 1,
  updatedAt: 2,
};

describe('parsePublicCollection', () => {
  it('keeps the collection and usable recipes', () => {
    const parsed = parsePublicCollection({
      collection: { id: 'c1', name: 'Soups' },
      recipes: [recipe, { ...recipe, id: '', title: 'broken' }, null],
    });
    expect(parsed?.collection).toEqual({ id: 'c1', name: 'Soups' });
    expect(parsed?.recipes.map((r) => r.title)).toEqual(['Soup']);
  });

  it('rejects a wrong envelope', () => {
    expect(parsePublicCollection(null)).toBeNull();
    expect(parsePublicCollection({ recipes: [] })).toBeNull();
    expect(parsePublicCollection({ collection: { id: 'c1', name: 'x' } })).toBeNull();
    expect(parsePublicCollection({ collection: { id: 1, name: 'x' }, recipes: [] })).toBeNull();
  });
});

describe('publicPhotoUrl', () => {
  it('points at the public photo route for that recipe', () => {
    expect(publicPhotoUrl('tok', 'r1', 'p1')).toBe('/api/public/tok/recipes/r1/photos/p1');
  });
});
