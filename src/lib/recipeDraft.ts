import type { RecipeDraft } from './types';

/** A draft with the minimum shape the editor needs to render a usable form. */
export function blankDraft(): RecipeDraft {
  return {
    title: '',
    servings: 2,
    ingredientSections: [{ items: [{ item: '' }] }],
    steps: [{ text: '' }],
    tags: [],
  };
}
