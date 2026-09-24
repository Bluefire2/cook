/**
 * Turns an imported recipe into a `recipe.put` payload the push layer will
 * accept. The model's output is already cleaned by `normalizeImportedRecipe`
 * in `server/recipeImport.ts`; this adds identity, timestamps and sourceUrl,
 * and refuses a payload the push validator would reject for size.
 */
import type { ImportedRecipe } from './recipeImport.ts';

/** `validateRecipePut` compares `JSON.stringify(payload).length` against this. */
const MAX_PAYLOAD_CHARS = 200_000;

/** Returns `null` when the payload would be too large to push. */
export function recipePutFromExtraction(
  recipe: ImportedRecipe,
  options: { id: string; now: number; sourceUrl?: string },
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {
    id: options.id,
    createdAt: options.now,
    updatedAt: options.now,
    ...recipe,
  };

  const sourceUrl = options.sourceUrl?.trim();
  if (sourceUrl) payload.sourceUrl = sourceUrl;

  if (JSON.stringify(payload).length >= MAX_PAYLOAD_CHARS) {
    return null;
  }

  return payload;
}
