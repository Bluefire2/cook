import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDraft } from './types';
import * as session from './session';
import { requestTranslation, translateRecipe } from './translateApi';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/translate');
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const recipe: RecipeDraft = {
  title: 'Carbonara',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'guanciale' }] }],
  steps: [{ text: 'Fry it.' }],
  tags: [],
  lang: 'it',
  sourceUrl: 'https://example.com/carbonara',
};

describe('translateRecipe', () => {
  it('posts the recipe and target without a recipeId', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ detectedLang: 'it', recipe: { ...recipe, title: 'Карбонара' } }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const translated = await translateRecipe({ recipe, target: 'uk', sourceLang: 'it' });
    expect(translated.title).toBe('Карбонара');
    const body = postedBody(fetchMock);
    expect(body.target).toBe('uk');
    expect(body.sourceLang).toBe('it');
    expect(body.recipe).toMatchObject({ title: 'Carbonara' });
    expect(body).not.toHaveProperty('recipeId');
  });

  it('omits sourceLang when the guess is empty', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ recipe }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await translateRecipe({ recipe, target: 'en' });
    const body = postedBody(fetchMock);
    expect(body).not.toHaveProperty('sourceLang');
    expect(body).not.toHaveProperty('recipeId');
  });

  it('posts recipeId and returns detectedLang for a saved recipe', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ detectedLang: 'IT', recipe: { ...recipe, title: 'Карбонара' } }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestTranslation({
      recipe,
      target: 'uk',
      sourceLang: 'it',
      recipeId: 'recipe-1',
    });
    expect(result.recipe.title).toBe('Карбонара');
    expect(result.detectedLang).toBe('it');
    const body = postedBody(fetchMock);
    expect(body.recipeId).toBe('recipe-1');
    expect(body.target).toBe('uk');
    expect(body.sourceLang).toBe('it');
  });

  it('invalidates the session on 401', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })),
    );
    await expect(translateRecipe({ recipe, target: 'uk' })).rejects.toThrow(/sign in/i);
    expect(invalidateSpy).toHaveBeenCalledOnce();
  });
});
