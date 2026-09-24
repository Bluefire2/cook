/**
 * Turns a Gemini extraction into a `recipe.put` payload the push layer will
 * accept. Server-side counterpart of `normalizeRecipeDraft` in
 * `src/lib/recipeShape.ts`, which cannot be reused: the runtime image copies
 * `dist`, `api`, `server` and `scripts`, never `src`.
 *
 * The extension has no review step, so this is the only thing standing between
 * a model's output and the library. It repairs what can be repaired and gives
 * up on what cannot.
 */

/** `validateRecipePut` compares `JSON.stringify(payload).length` against this. */
const MAX_PAYLOAD_CHARS = 200_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeIngredient(item: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(item)) return undefined;
  const itemText = nonEmptyString(item.item);
  if (itemText === undefined) return undefined;
  const result: Record<string, unknown> = { item: itemText };
  const quantity = finiteNumber(item.quantity);
  if (quantity !== undefined) result.quantity = quantity;
  const unit = nonEmptyString(item.unit);
  if (unit !== undefined) result.unit = unit;
  const note = nonEmptyString(item.note);
  if (note !== undefined) result.note = note;
  return result;
}

function normalizeIngredientSections(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const sections: Record<string, unknown>[] = [];
  for (const section of value) {
    if (!isPlainObject(section)) continue;
    const items = (Array.isArray(section.items) ? section.items : [])
      .map(normalizeIngredient)
      .filter((item): item is Record<string, unknown> => item !== undefined);
    if (items.length === 0) continue;
    const name = nonEmptyString(section.name);
    sections.push(name !== undefined ? { name, items } : { items });
  }
  return sections;
}

function normalizeSteps(value: unknown): { text: string }[] {
  if (!Array.isArray(value)) return [];
  const steps: { text: string }[] = [];
  for (const step of value) {
    if (!isPlainObject(step)) continue;
    const text = nonEmptyString(step.text);
    if (text !== undefined) steps.push({ text });
  }
  return steps;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    const trimmed = nonEmptyString(tag);
    if (trimmed !== undefined && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}

/**
 * Returns `null` when the draft cannot be saved at all. `title` is the only
 * field with no sensible repair; everything else is normalized or dropped.
 */
export function recipePutFromExtraction(
  draft: unknown,
  options: { id: string; now: number; sourceUrl?: string },
): Record<string, unknown> | null {
  if (!isPlainObject(draft)) return null;

  const title = nonEmptyString(draft.title);
  if (title === undefined) return null;

  // A missing or nonsensical serving count would break the recipe view's
  // scaler, and there is no review step to catch it. One serving is wrong but
  // usable, and editable in the app.
  const servings = finiteNumber(draft.servings);

  const payload: Record<string, unknown> = {
    id: options.id,
    createdAt: options.now,
    updatedAt: options.now,
    title,
    servings: servings === undefined || servings < 1 ? 1 : servings,
    ingredientSections: normalizeIngredientSections(draft.ingredientSections),
    steps: normalizeSteps(draft.steps),
    tags: normalizeTags(draft.tags),
  };

  const description = nonEmptyString(draft.description);
  if (description !== undefined) payload.description = description;

  const notes = nonEmptyString(draft.notes);
  if (notes !== undefined) payload.notes = notes;

  const sourceUrl = nonEmptyString(options.sourceUrl);
  if (sourceUrl !== undefined) payload.sourceUrl = sourceUrl;

  const prepMinutes = finiteNumber(draft.prepMinutes);
  if (prepMinutes !== undefined && prepMinutes >= 0) payload.prepMinutes = prepMinutes;

  const cookMinutes = finiteNumber(draft.cookMinutes);
  if (cookMinutes !== undefined && cookMinutes >= 0) payload.cookMinutes = cookMinutes;

  if (JSON.stringify(payload).length >= MAX_PAYLOAD_CHARS) {
    return null;
  }

  return payload;
}
