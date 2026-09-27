import { describe, expect, it } from 'vitest';
import { MAX_TRANSLATE_CHARS, MAX_TRANSLATE_SEGMENTS } from './recipeTranslation.ts';
import {
  TRANSLATE_BAD_REQUEST,
  TRANSLATE_TOO_LARGE,
  classifyTranslateRecipeId,
  parseTranslateRequest,
} from './translateRoute.ts';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

function recipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Soup',
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { target: 'en', recipe: recipe(), ...overrides };
}

describe('classifyTranslateRecipeId', () => {
  it('omits a missing id and accepts a uuid', () => {
    expect(classifyTranslateRecipeId(undefined)).toEqual({ kind: 'omit' });
    expect(classifyTranslateRecipeId(UUID)).toEqual({ kind: 'ok', recipeId: UUID });
  });

  it('rejects a non-uuid and a value that contains a slash', () => {
    expect(classifyTranslateRecipeId('not-a-uuid')).toEqual({ kind: 'invalid' });
    expect(classifyTranslateRecipeId(`${UUID}/translations`)).toEqual({ kind: 'invalid' });
    expect(classifyTranslateRecipeId('a/b')).toEqual({ kind: 'invalid' });
  });
});

describe('parseTranslateRequest', () => {
  it('returns 400 for a non-uuid recipeId and for a recipeId that contains a slash', () => {
    expect(parseTranslateRequest(body({ recipeId: 'not-a-uuid' }))).toEqual({
      ok: false,
      status: 400,
      code: TRANSLATE_BAD_REQUEST,
      error: 'Bad request',
    });
    expect(parseTranslateRequest(body({ recipeId: `${UUID}/extra` }))).toEqual({
      ok: false,
      status: 400,
      code: TRANSLATE_BAD_REQUEST,
      error: 'Bad request',
    });
    expect(parseTranslateRequest(body({ recipeId: 'users/someone/recipes/1' }))).toEqual({
      ok: false,
      status: 400,
      code: TRANSLATE_BAD_REQUEST,
      error: 'Bad request',
    });
  });

  it('accepts a uuid recipeId and normalizes an alias target', () => {
    const parsed = parseTranslateRequest(body({ recipeId: UUID, target: 'ua' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.recipeId).toBe(UUID);
      expect(parsed.target).toBe('uk');
    }
  });

  it('omits recipeId when the field is absent', () => {
    const parsed = parseTranslateRequest(body());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.recipeId).toBeUndefined();
    }
  });

  it('returns 413 when the segment or character cap is exceeded', () => {
    const tooManySteps = Array.from({ length: MAX_TRANSLATE_SEGMENTS }, () => ({ text: 'a' }));
    expect(
      parseTranslateRequest(body({ recipe: recipe({ steps: tooManySteps }) })),
    ).toEqual({
      ok: false,
      status: 413,
      code: TRANSLATE_TOO_LARGE,
      error: 'This recipe is too long to translate.',
    });

    const tooLong = 'y'.repeat(MAX_TRANSLATE_CHARS);
    expect(
      parseTranslateRequest(body({ recipe: recipe({ title: 'S', steps: [{ text: tooLong }] }) })),
    ).toEqual({
      ok: false,
      status: 413,
      code: TRANSLATE_TOO_LARGE,
      error: 'This recipe is too long to translate.',
    });
  });

  it('allows a recipe that sits on both caps', () => {
    const steps = Array.from({ length: MAX_TRANSLATE_SEGMENTS - 1 }, () => ({ text: 'a' }));
    const parsed = parseTranslateRequest(body({ recipe: recipe({ title: 'S', steps }) }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.segments).toHaveLength(MAX_TRANSLATE_SEGMENTS);
    }
  });

  it('returns 400 for an unsupported target', () => {
    expect(parseTranslateRequest(body({ target: 'it' }))).toMatchObject({
      ok: false,
      status: 400,
      code: TRANSLATE_BAD_REQUEST,
    });
  });
});
