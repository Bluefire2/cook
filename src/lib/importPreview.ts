import { sameLanguage } from '../i18n/lang';
import type { RecipeDraft } from './types';

export interface ImportPreviewInput {
  /** Language of the original text. Missing when the import could not guess. */
  sourceLang: string | undefined;
  /** UI language, which is the translation target. */
  uiLang: string;
  translationFailed: boolean;
  /** Pasted text has no source URL. This changes the hint only, not the default. */
  pasted: boolean;
  /**
   * Whether the translate checkbox is checked. Ignored when the checkbox
   * is hidden. The default, whenever the checkbox is shown, is checked.
   */
  translateChecked: boolean;
}

export interface ImportPreviewRules {
  showCheckbox: boolean;
  /** True when the checkbox is shown. It does not depend on pasted vs URL. */
  defaultChecked: boolean;
  showPastedHint: boolean;
  /** UI language when saving the translation; `sourceLang` when saving the original. */
  saveLang: string | undefined;
}

/**
 * Checkbox visibility and the `lang` stored at save.
 * `sameLanguage` `unknown` (no guess, or a bare `zh`) counts as different,
 * matching the server import pipeline. A failed translation hides the checkbox.
 */
export function importPreviewRules(input: ImportPreviewInput): ImportPreviewRules {
  const showCheckbox =
    !input.translationFailed && sameLanguage(input.sourceLang, input.uiLang) !== 'same';
  const saveTranslated = showCheckbox && input.translateChecked;
  return {
    showCheckbox,
    defaultChecked: showCheckbox,
    showPastedHint: showCheckbox && input.pasted,
    saveLang: saveTranslated ? input.uiLang : input.sourceLang,
  };
}

/**
 * The translated text plus the original's link and photos. Translation
 * responses carry text only; `sourceUrl` is the way back to a URL import.
 */
export function translatedPreviewDraft(original: RecipeDraft, translated: RecipeDraft): RecipeDraft {
  return {
    ...translated,
    ...(original.sourceUrl !== undefined ? { sourceUrl: original.sourceUrl } : {}),
    ...(original.photoId !== undefined ? { photoId: original.photoId } : {}),
    ...(original.galleryPhotoIds !== undefined && original.galleryPhotoIds.length > 0
      ? { galleryPhotoIds: original.galleryPhotoIds }
      : {}),
  };
}
