import { settings } from './settings';
import type { Recipe } from './types';

export type ExtractedRecipe = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

export async function importRecipe(params: {
  url?: string;
  text?: string;
}): Promise<ExtractedRecipe> {
  const response = await fetch('/api/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-password': settings.getPassword(),
    },
    body: JSON.stringify(params),
  });

  if (response.status === 401) {
    throw new Error('Wrong or missing app password — set it in Settings.');
  }
  const data = (await response.json().catch(() => null)) as
    | { recipe?: ExtractedRecipe; error?: string }
    | null;
  if (!response.ok || !data?.recipe) {
    throw new Error(data?.error ?? `Import failed (${response.status}).`);
  }

  return {
    ...data.recipe,
    tags: data.recipe.tags ?? [],
    ingredientSections: data.recipe.ingredientSections ?? [],
    steps: data.recipe.steps ?? [],
  };
}
