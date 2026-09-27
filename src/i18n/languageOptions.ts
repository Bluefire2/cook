import { languageName } from './index';
import { ISO_639_1_CODES } from './iso639';
import { SUPPORTED_LOCALES, type Locale } from './lang';

export interface LanguageOption {
  value: string;
  label: string;
}

export interface LanguagePickerOptions {
  /** Set when `value` is not already in either group, so saving cannot drop it. */
  current?: LanguageOption;
  app: LanguageOption[];
  all: LanguageOption[];
}

/**
 * App languages stay in their own group, in list order. All languages is every
 * ISO 639-1 code plus `zh-Hant`, sorted by the UI-language name.
 * A code `names` cannot name is omitted. A current value that is still missing
 * stays, labeled with its name or, only then, the tag itself.
 */
export function buildLanguagePickerOptions(
  uiLocale: Locale,
  value: string | undefined,
  names: (tag: string, uiLocale: Locale) => string | undefined = languageName,
): LanguagePickerOptions {
  const named = (tag: string): LanguageOption | undefined => {
    const label = names(tag, uiLocale);
    return label === undefined ? undefined : { value: tag, label };
  };

  const app = SUPPORTED_LOCALES.flatMap((tag) => {
    const option = named(tag);
    return option === undefined ? [] : [option];
  });

  const all = [...ISO_639_1_CODES, 'zh-Hant']
    .flatMap((tag) => {
      const option = named(tag);
      return option === undefined ? [] : [option];
    })
    .sort((a, b) => a.label.localeCompare(b.label, uiLocale));

  const known = new Set([...app, ...all].map((option) => option.value));
  if (value === undefined || value === '' || known.has(value)) {
    return { app, all };
  }
  return {
    current: { value, label: names(value, uiLocale) ?? value },
    app,
    all,
  };
}
