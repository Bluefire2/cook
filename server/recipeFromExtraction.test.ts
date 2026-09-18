import { describe, expect, it } from 'vitest';
import { recipePutFromExtraction } from './recipeFromExtraction.ts';
import { validatePushOp } from './store.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const NOW = 1_700_000_000_000;

function build(draft: unknown, sourceUrl = 'https://example.com/recipe') {
  return recipePutFromExtraction(draft, { id: ID, now: NOW, sourceUrl });
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
    const payload = recipePutFromExtraction(MINIMAL, { id: ID, now: NOW });
    expect(payload).not.toBeNull();
    expect('sourceUrl' in (payload ?? {})).toBe(false);
  });

  it('returns null without a usable title', () => {
    expect(build({ ...MINIMAL, title: '   ' })).toBeNull();
    expect(build({ ...MINIMAL, title: 42 })).toBeNull();
    expect(build({ ...MINIMAL, title: undefined })).toBeNull();
    expect(build('not an object')).toBeNull();
    expect(build(null)).toBeNull();
  });

  it('defaults an unusable serving count to 1', () => {
    for (const servings of [undefined, 0, -3, Number.NaN, Infinity, 'four']) {
      expect(build({ ...MINIMAL, servings })).toMatchObject({ servings: 1 });
    }
    expect(build({ ...MINIMAL, servings: 2.5 })).toMatchObject({ servings: 2.5 });
  });

  it('trims strings and drops ingredients without an item', () => {
    const payload = build({
      ...MINIMAL,
      title: '  Tomato soup  ',
      ingredientSections: [
        {
          name: '  Base  ',
          items: [
            { item: '  tomatoes  ', quantity: 6, unit: ' piece ', note: ' ripe ' },
            { item: '   ' },
            { quantity: 2 },
            'nonsense',
          ],
        },
      ],
    });
    expect(payload).toMatchObject({
      title: 'Tomato soup',
      ingredientSections: [
        {
          name: 'Base',
          items: [{ item: 'tomatoes', quantity: 6, unit: 'piece', note: 'ripe' }],
        },
      ],
    });
  });

  it('drops sections that end up empty, and malformed steps and tags', () => {
    expect(
      build({
        ...MINIMAL,
        ingredientSections: [{ items: [] }, { items: ['x'] }, 'nope', { name: 'Sauce' }],
        steps: [{ text: 'Keep.' }, { text: '  ' }, { notText: 1 }, 'nope'],
        tags: ['soup', ' soup ', '', 7, 'winter'],
      }),
    ).toMatchObject({
      ingredientSections: [],
      steps: [{ text: 'Keep.' }],
      tags: ['soup', 'winter'],
    });
  });

  it('keeps arrays present when the model omits them entirely', () => {
    const payload = build({ title: 'Bare', servings: 1 });
    expect(payload).toMatchObject({
      ingredientSections: [],
      steps: [],
      tags: [],
    });
    expect(validatePushOp({ kind: 'recipe.put', payload })).toMatchObject({ ok: true });
  });

  it('drops negative durations rather than saving them', () => {
    const payload = build({ ...MINIMAL, prepMinutes: -5, cookMinutes: 0 });
    expect('prepMinutes' in (payload ?? {})).toBe(false);
    expect(payload).toMatchObject({ cookMinutes: 0 });
  });

  it('returns null at the size the push validator would reject', () => {
    const payload = build({
      ...MINIMAL,
      notes: 'x'.repeat(200_000),
    });
    expect(payload).toBeNull();
  });
});
