import { t } from '../i18n';
import type { Locale } from '../i18n';
import { serverErrorText } from './errorText';
import { invalidateSession } from './session';
import type { RecipeDraft } from './types';

function asDraft(value: unknown): RecipeDraft | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const recipe = value as Partial<RecipeDraft>;
  if (typeof recipe.title !== 'string' || typeof recipe.servings !== 'number') {
    return undefined;
  }
  if (!Array.isArray(recipe.ingredientSections) || !Array.isArray(recipe.steps) || !Array.isArray(recipe.tags)) {
    return undefined;
  }
  return {
    ...recipe,
    title: recipe.title,
    servings: recipe.servings,
    tags: recipe.tags,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
  };
}

/**
 * Translates a recipe that has no id yet (the import preview, after the
 * person corrects the guessed language). No `recipeId`, so the server does
 * not cache it.
 */
export async function translateRecipe(params: {
  recipe: RecipeDraft;
  target: Locale;
  sourceLang?: string;
  signal?: AbortSignal;
}): Promise<RecipeDraft> {
  const response = await fetch('/api/translate', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: params.target,
      ...(params.sourceLang !== undefined ? { sourceLang: params.sourceLang } : {}),
      recipe: params.recipe,
    }),
    signal: params.signal,
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }

  const data = (await response.json().catch(() => null)) as { recipe?: unknown } | null;
  const recipe = asDraft(data?.recipe);
  if (!response.ok || recipe === undefined) {
    throw new Error(serverErrorText(data, 'error.translateFailed'));
  }
  return recipe;
}
