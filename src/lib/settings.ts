import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  normalizeLang,
  toSupportedLocale,
  type Locale,
} from '../i18n/lang';

export const THEME_KEY = 'cook.theme';
export const LOCALE_KEY = 'cook.locale';

export type Theme = 'dark' | 'light';

const localeListeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * UI language implied by a browser language. A bare `zh` picks the only
 * Chinese UI, `zh-Hans`; anything unsupported (including `zh-Hant`) is `en`.
 */
export function localeFromBrowserLanguage(browserLanguage: unknown): Locale {
  if (normalizeLang(browserLanguage) === 'zh') {
    return 'zh-Hans';
  }
  return toSupportedLocale(browserLanguage) ?? DEFAULT_LOCALE;
}

/** Mirrors the current locale onto `<html lang>` so CSS and screen readers agree with the copy. */
export function applyLocale(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

export const settings = {
  getTheme(): Theme {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  },
  setTheme(value: Theme): void {
    localStorage.setItem(THEME_KEY, value);
  },
  getLocale(): Locale {
    const stored = readStorage(LOCALE_KEY);
    if (isSupportedLocale(stored)) {
      return stored;
    }
    return localeFromBrowserLanguage(
      typeof navigator === 'undefined' ? undefined : navigator.language,
    );
  },
  setLocale(value: Locale): void {
    localStorage.setItem(LOCALE_KEY, value);
    applyLocale(value);
    for (const listener of localeListeners) {
      listener();
    }
  },
  subscribeLocale(listener: () => void): () => void {
    localeListeners.add(listener);
    return () => {
      localeListeners.delete(listener);
    };
  },
};
