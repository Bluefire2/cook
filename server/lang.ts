/**
 * Language-tag helpers shared by the client and the server.
 *
 * This file exists twice: `src/i18n/lang.ts` and `server/lang.ts`. The server
 * image copies only `api/`, `server/`, and `scripts/`, so it cannot import
 * from `src/`. `server/lang.test.ts` runs one table of cases through both
 * copies and asserts the two files are textually identical. Change both
 * together. Keep this module free of `navigator`, `document`, and
 * `localStorage`: the node tsconfig type-checks it without DOM types.
 */

/** The closed list of UI languages (constitution principle 15). */
export const SUPPORTED_LOCALES = ['en', 'uk', 'ru', 'zh-Hans'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export type LanguageComparison = 'same' | 'different' | 'unknown';

/** Country codes commonly mistaken for language codes. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ua: 'uk',
  cn: 'zh',
  jp: 'ja',
  gr: 'el',
  cz: 'cs',
  dk: 'da',
  se: 'sv',
};

/** Chinese script implied by a region when no script subtag is present. */
const CHINESE_SCRIPT_BY_REGION: Readonly<Record<string, string>> = {
  CN: 'Hans',
  SG: 'Hans',
  TW: 'Hant',
  HK: 'Hant',
  MO: 'Hant',
};

/**
 * Normalizes any language value to the canonical stored form, or `undefined`
 * when it cannot be understood. Rules, in order: canonical case through
 * `Intl.getCanonicalLocales` (unparseable input is dropped), the alias map
 * for country-code mistakes, Chinese script from an explicit script or from
 * the region, then everything but the language (plus script for `zh`) is
 * stripped. A bare `zh` stays `zh`.
 */
export function normalizeLang(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const raw = input.trim().replace(/_/g, '-');
  if (raw === '') {
    return undefined;
  }
  let canonical: string;
  try {
    const [first] = Intl.getCanonicalLocales(raw);
    if (!first) {
      return undefined;
    }
    canonical = first;
  } catch {
    return undefined;
  }
  let parsed: Intl.Locale;
  try {
    parsed = new Intl.Locale(canonical);
  } catch {
    return undefined;
  }
  const language = LANGUAGE_ALIASES[parsed.language] ?? parsed.language;
  if (language.length < 2 || language.length > 3) {
    return undefined;
  }
  if (language !== 'zh') {
    return language;
  }
  const script =
    parsed.script ?? (parsed.region ? CHINESE_SCRIPT_BY_REGION[parsed.region] : undefined);
  return script ? `zh-${script}` : 'zh';
}

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Normalizes a value and returns it only if it is one of the UI languages.
 * `zh-CN` therefore yields `zh-Hans`, while a bare `zh` yields `undefined`
 * (the browser-language default in `src/lib/settings.ts` decides that case).
 */
export function toSupportedLocale(input: unknown): Locale | undefined {
  const tag = normalizeLang(input);
  return isSupportedLocale(tag) ? tag : undefined;
}

/** Primary language subtag of a normalized tag (`zh-Hans` → `zh`). */
export function primaryLanguage(tag: string): string {
  return tag.split('-')[0];
}

/**
 * Whether two language values name the same language. Primary subtags are
 * compared after normalization. For Chinese the script matters: `zh-Hans`
 * against `zh-Hant` is `different`, and a bare `zh` on either side is
 * `unknown`. A value that cannot be normalized is also `unknown`.
 */
export function sameLanguage(a: unknown, b: unknown): LanguageComparison {
  const left = normalizeLang(a);
  const right = normalizeLang(b);
  if (left === undefined || right === undefined) {
    return 'unknown';
  }
  const leftPrimary = primaryLanguage(left);
  const rightPrimary = primaryLanguage(right);
  if (leftPrimary !== rightPrimary) {
    return 'different';
  }
  if (leftPrimary !== 'zh') {
    return 'same';
  }
  if (left === 'zh' || right === 'zh') {
    return 'unknown';
  }
  return left === right ? 'same' : 'different';
}
