import { MIN_STEPS, type ImportCheck, type ImportWarning } from '../../server/importWarnings.ts';
import type { Recipe } from './types';

export {
  IMPORT_WARNING_CODES,
  compactImportCheck,
  isImportWarningCode,
  readImportWarnings,
  type ImportCheck,
  type ImportWarning,
  type ImportWarningCode,
} from '../../server/importWarnings.ts';

/** The imported text of a recipe: what an edit after import can change. Tags and photos are not. */
type RecipeContent = Pick<
  Recipe,
  | 'title'
  | 'description'
  | 'servings'
  | 'prepMinutes'
  | 'cookMinutes'
  | 'ingredientSections'
  | 'steps'
  | 'notes'
>;

/** JSON with object keys sorted and `undefined` dropped, so key order never reads as an edit. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function contentKey(recipe: RecipeContent): string {
  return canonical([
    recipe.title,
    recipe.description,
    recipe.servings,
    recipe.prepMinutes,
    recipe.cookMinutes,
    recipe.ingredientSections,
    recipe.steps,
    recipe.notes,
  ]);
}

function ingredientCount(recipe: RecipeContent): number {
  return recipe.ingredientSections.reduce((n, section) => n + section.items.length, 0);
}

/** Whether a warning still describes `after`, given what changed since `before`. */
function stillHolds(warning: ImportWarning, before: RecipeContent, after: RecipeContent): boolean {
  const sectionsChanged = canonical(before.ingredientSections) !== canonical(after.ingredientSections);
  switch (warning.code) {
    case 'MISSING_INSTRUCTIONS':
    case 'INSTRUCTIONS_DROPPED':
    case 'INSTRUCTIONS_NOT_ON_PAGE':
      return after.steps.length === 0;
    case 'TOO_FEW_STEPS':
      return after.steps.length < MIN_STEPS;
    case 'MISSING_INGREDIENTS':
      return ingredientCount(after) === 0;
    case 'MISSING_TITLE':
      return after.title.trim() === '';
    case 'STEP_COUNT_MISMATCH':
      return after.steps.length <= before.steps.length;
    case 'INGREDIENT_COUNT_MISMATCH':
      return ingredientCount(after) <= ingredientCount(before);
    case 'EMPTY_ITEMS':
      return !sectionsChanged && canonical(before.steps) === canonical(after.steps);
    case 'UNGROUNDED_INGREDIENT': {
      // A position means nothing once the list has changed.
      if (sectionsChanged || warning.at === undefined) return false;
      const [section, item] = warning.at;
      return after.ingredientSections[section]?.items[item] !== undefined;
    }
  }
}

/**
 * The import check after an edit from `before` to `after`. With no content
 * change it is returned as is, so a Dismiss (which changes only
 * `dismissedAt`) is never an edit. The first content change sets `editedAt`.
 * A warning whose condition no longer holds is dropped: steps were added,
 * ingredients were added, or the ingredient list a position pointed into
 * changed. `dismissedAt` is kept. A record whose warnings all resolve stays,
 * with no warnings, so `editedAt` still counts the fix.
 */
export function reconcileImportCheck(
  check: ImportCheck | undefined,
  before: RecipeContent,
  after: RecipeContent,
  now: number,
): ImportCheck | undefined {
  if (check === undefined || contentKey(before) === contentKey(after)) return check;
  const next: ImportCheck = {
    ...check,
    warnings: check.warnings.filter((warning) => stillHolds(warning, before, after)),
  };
  if (next.editedAt === undefined) next.editedAt = now;
  return next;
}

/** The banner shows to someone who can edit, while warnings remain and none were dismissed. */
export function showsImportWarnings(check: ImportCheck | undefined, canEdit: boolean): boolean {
  return canEdit && check !== undefined && check.warnings.length > 0 && check.dismissedAt === undefined;
}
