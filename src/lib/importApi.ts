import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { invalidateSession } from './session';
import type { RecipeDraft } from './types';

export type ExtractedRecipe = RecipeDraft;

/**
 * `translation` is kept for the import preview. Until that preview exists,
 * callers save `recipe` (the original extraction).
 */
export interface ImportRecipeResult {
  recipe: ExtractedRecipe;
  translation?: { lang: string; recipe: ExtractedRecipe };
  translationFailed?: true;
}

function drafted(recipe: ExtractedRecipe): ExtractedRecipe {
  return {
    ...recipe,
    tags: recipe.tags ?? [],
    ingredientSections: recipe.ingredientSections ?? [],
    steps: recipe.steps ?? [],
  };
}

export async function importRecipe(params: {
  url?: string;
  text?: string;
  translateTo?: string;
}): Promise<ImportRecipeResult> {
  const response = await fetch('/api/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  const data = (await response.json().catch(() => null)) as
    | {
        recipe?: ExtractedRecipe;
        translation?: { lang?: unknown; recipe?: ExtractedRecipe };
        translationFailed?: unknown;
        error?: string;
        code?: string;
        status?: number;
      }
    | null;
  if (!response.ok || !data?.recipe) {
    throw new Error(
      serverErrorText(data, 'error.importFailedStatus', { status: response.status }),
    );
  }

  const result: ImportRecipeResult = { recipe: drafted(data.recipe) };
  if (data.translationFailed === true) {
    result.translationFailed = true;
  }
  const translation = data.translation;
  if (
    translation !== undefined &&
    typeof translation.lang === 'string' &&
    translation.recipe !== undefined
  ) {
    result.translation = { lang: translation.lang, recipe: drafted(translation.recipe) };
  }
  return result;
}
