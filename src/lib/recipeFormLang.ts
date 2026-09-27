import { sameLanguage } from '../i18n/lang';

/**
 * Initial value of the recipe-language field.
 * A stored tag is kept, including one the picker does not list.
 * A recipe with no `lang` takes a detection for this version. The UI
 * language fills in only when the caller passes it, which is a new recipe;
 * an edit passes `undefined` and stays unlabelled. Choosing Unknown later
 * clears the field; that clear is not passed back through this function.
 * This does not write the recipe.
 */
export function defaultRecipeFormLang(
  lang: string | undefined,
  uiLocale: string | undefined,
  detectedLang?: string,
): string | undefined {
  if (lang !== undefined) return lang;
  if (detectedLang !== undefined) return detectedLang;
  return uiLocale;
}

/**
 * Detected tag for the "Looks like …" control.
 * The field keeps its current tag. The hint is offered when that tag and the
 * detection are not the same language (`different`, or `unknown` such as a
 * bare `zh`). A missing field is a pre-fill, not a hint. Nothing is written
 * until the person saves.
 */
export function detectedLangHint(
  fieldLang: string | undefined,
  detectedLang: string | undefined,
): string | undefined {
  if (fieldLang === undefined || detectedLang === undefined) return undefined;
  if (sameLanguage(fieldLang, detectedLang) === 'same') return undefined;
  return detectedLang;
}
