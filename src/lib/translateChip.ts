import { sameLanguage } from '../i18n/lang';

export type TranslateChipMode =
  | 'hidden'
  | 'unlabelled'
  | 'labelled'
  | 'loading'
  | 'translated'
  | 'error';

/**
 * Which translate chip to show for this recipe version.
 * A match with the UI language hides it. A bare `zh` is `unknown`, so the
 * chip stays. Loading and error belong to the latest tap. The translated
 * view keeps the chip so the person can return to the original.
 */
export function translateChipMode(input: {
  effectiveLang: string | undefined;
  uiLang: string;
  viewingTranslation?: boolean;
  pending?: 'loading' | 'error';
}): TranslateChipMode {
  if (input.pending === 'loading') return 'loading';
  if (input.pending === 'error') return 'error';
  if (input.viewingTranslation === true) return 'translated';
  if (sameLanguage(input.effectiveLang, input.uiLang) === 'same') return 'hidden';
  if (input.effectiveLang === undefined) return 'unlabelled';
  return 'labelled';
}
