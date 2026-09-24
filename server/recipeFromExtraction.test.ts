import { describe, expect, it } from 'vitest';
import { recipePutFromExtraction } from './recipeFromExtraction.ts';
import { normalizeImportedRecipe, type ImportedRecipe } from './recipeImport.ts';
import { validatePushOp } from './store.ts';

// Cleanup of the model's output is `normalizeImportedRecipe`'s job and is
// tested in recipeImport.test.ts. These cover what is added on top of it.

const ID = '11111111-2222-4333-8444-555555555555';
const NOW = 1_700_000_000_000;

function normalized(raw: unknown): ImportedRecipe {
  const recipe = normalizeImportedRecipe(raw);
  if (recipe === null) throw new Error('fixture does not normalize');
  return recipe;
}

function build(raw: unknown, sourceUrl = 'https://example.com/recipe') {
  return recipePutFromExtraction(normalized(raw), { id: ID, now: NOW, sourceUrl });
}

const MINIMAL = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
  steps: [{ text: 'Simmer.' }],
  tags: ['soup'],
};

describe('recipePutFromExtraction', () => {
  it('produces a payload the push validator accepts', () => {
    const payload = build(MINIMAL);
    expect(payload).not.toBeNull();
    expect(validatePushOp({ kind: 'recipe.put', payload })).toEqual({
      ok: true,
      op: { kind: 'recipe.put', payload },
    });
  });

  it('stamps id, timestamps and sourceUrl', () => {
    expect(build(MINIMAL)).toMatchObject({
      id: ID,
      createdAt: NOW,
      updatedAt: NOW,
      sourceUrl: 'https://example.com/recipe',
    });
  });

  it('emits only keys compactRecipeFields keeps', () => {
    const payload = build({
      ...MINIMAL,
      description: 'Warming.',
      notes: 'Freezes well.',
      prepMinutes: 5,
      cookMinutes: 20,
      photoId: 'not-from-a-model',
      nutrition: { calories: 100 },
    });
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'cookMinutes',
      'createdAt',
      'description',
      'id',
      'ingredientSections',
      'notes',
      'prepMinutes',
      'servings',
      'sourceUrl',
      'steps',
      'tags',
      'title',
      'updatedAt',
    ]);
  });

  it('omits sourceUrl when there is none', () => {
    for (const sourceUrl of [undefined, '', '   ']) {
      const payload = recipePutFromExtraction(normalized(MINIMAL), { id: ID, now: NOW, sourceUrl });
      expect(payload).not.toBeNull();
      expect('sourceUrl' in (payload ?? {})).toBe(false);
    }
  });

  it('is accepted by the push validator when the model omitted every array', () => {
    const payload = build({ title: 'Bare', servings: 1 });
    expect(payload).toMatchObject({
      ingredientSections: [],
      steps: [],
      tags: [],
    });
    expect(validatePushOp({ kind: 'recipe.put', payload })).toMatchObject({ ok: true });
  });

  it('is accepted by the push validator after servings were repaired', () => {
    const payload = build({ ...MINIMAL, servings: 0 });
    expect(payload).toMatchObject({ servings: 1 });
    expect(validatePushOp({ kind: 'recipe.put', payload })).toMatchObject({ ok: true });
  });

  it('returns null at the size the push validator would reject', () => {
    const payload = build({
      ...MINIMAL,
      notes: 'x'.repeat(200_000),
    });
    expect(payload).toBeNull();
  });
});
