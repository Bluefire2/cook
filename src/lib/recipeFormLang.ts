/**
 * Initial value of the recipe-language field.
 * A recipe with no `lang` takes the UI language. A stored tag is kept,
 * including one the picker does not list.
 * Choosing Unknown later clears the field; that clear is not passed back
 * through this function.
 */
export function defaultRecipeFormLang(
  lang: string | undefined,
  uiLocale: string,
): string {
  return lang ?? uiLocale;
}
