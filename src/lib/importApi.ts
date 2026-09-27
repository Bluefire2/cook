import { t } from '../i18n';
import { invalidateSession } from './session';
import type { RecipeDraft } from './types';

export type ExtractedRecipe = RecipeDraft;

export async function importRecipe(params: {
  url?: string;
  text?: string;
}): Promise<ExtractedRecipe> {
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
    | { recipe?: ExtractedRecipe; error?: string }
    | null;
  if (!response.ok || !data?.recipe) {
    throw new Error(data?.error ?? t('error.importFailedStatus', { status: response.status }));
  }

  return {
    ...data.recipe,
    tags: data.recipe.tags ?? [],
    ingredientSections: data.recipe.ingredientSections ?? [],
    steps: data.recipe.steps ?? [],
  };
}
