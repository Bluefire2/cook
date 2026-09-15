/**
 * Canonical units for the recipe-form select. Ingredient storage remains a
 * freeform optional string (`unit?: string`); this list is a UI affordance
 * only and does not constrain persisted or imported values.
 */

export const COMMON_UNITS = [
  'piece',
  'tsp',
  'tbsp',
  'cup',
  'ml',
  'l',
  'g',
  'kg',
  'oz',
  'lb',
] as const;

export type CommonUnit = (typeof COMMON_UNITS)[number];

/** Sentinel select value for "off-list unit, typed by hand". */
export const CUSTOM_UNIT = '__custom__';

/** What the unit `<select>` is showing: no unit, a listed unit, or custom. */
export type UnitChoice = '' | CommonUnit | typeof CUSTOM_UNIT;

function isCommonUnit(unit: string): unit is CommonUnit {
  return (COMMON_UNITS as readonly string[]).includes(unit);
}

export function unitChoice(unit: string | undefined): UnitChoice {
  if (unit === undefined || unit === '') {
    return '';
  }
  if (isCommonUnit(unit)) {
    return unit;
  }
  return CUSTOM_UNIT;
}

export function resolveUnit(
  choice: UnitChoice,
  customText: string,
): string | undefined {
  if (choice === '') {
    return undefined;
  }
  if (choice === CUSTOM_UNIT) {
    const trimmed = customText.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return choice;
}
