import { describe, expect, it } from 'vitest';
import { buildLanguagePickerOptions } from './languageOptions';
import { ISO_639_1_CODES } from './iso639';
import { SUPPORTED_LOCALES } from './lang';

describe('ISO_639_1_CODES', () => {
  it('lists each two-letter code once', () => {
    expect(ISO_639_1_CODES).toHaveLength(184);
    expect(new Set(ISO_639_1_CODES).size).toBe(184);
    for (const code of ISO_639_1_CODES) {
      expect(code).toMatch(/^[a-z]{2}$/);
    }
    expect(ISO_639_1_CODES).not.toContain('zh-Hant');
    expect(ISO_639_1_CODES).toContain('zh');
  });
});

describe('buildLanguagePickerOptions', () => {
  const names = (tag: string): string | undefined => {
    const table: Record<string, string> = {
      en: 'English',
      uk: 'Ukrainian',
      ru: 'Russian',
      'zh-Hans': 'Chinese, Simplified',
      fr: 'French',
      it: 'Italian',
      'zh-Hant': 'Chinese, Traditional',
      zh: 'Chinese',
    };
    return table[tag];
  };

  it('keeps app languages in order and sorts the rest by name', () => {
    const options = buildLanguagePickerOptions('en', undefined, names);
    expect(options.app.map((option) => option.value)).toEqual([...SUPPORTED_LOCALES]);
    expect(options.all.map((option) => option.value)).toEqual([
      'zh',
      'zh-Hant',
      'en',
      'fr',
      'it',
      'ru',
      'uk',
    ]);
    expect(options.current).toBeUndefined();
    expect(options.all.map((option) => option.value)).not.toContain('zh-Hans');
  });

  it('omits codes the namer cannot name', () => {
    const options = buildLanguagePickerOptions('en', undefined, names);
    expect(options.all.some((option) => option.value === 'bh')).toBe(false);
    expect(options.all.every((option) => option.label !== option.value)).toBe(true);
  });

  it('keeps a current value that is not in either group', () => {
    const named = buildLanguagePickerOptions('en', 'yue', (tag) =>
      tag === 'yue' ? 'Cantonese' : names(tag),
    );
    expect(named.current).toEqual({ value: 'yue', label: 'Cantonese' });

    const raw = buildLanguagePickerOptions('en', 'xyz', names);
    expect(raw.current).toEqual({ value: 'xyz', label: 'xyz' });
    expect(raw.all.some((option) => option.value === 'xyz')).toBe(false);
  });

  it('does not repeat a value that is already listed', () => {
    const options = buildLanguagePickerOptions('en', 'it', names);
    expect(options.current).toBeUndefined();
    expect(options.all.filter((option) => option.value === 'it')).toHaveLength(1);
  });

  it('adds the code when two languages share a display name', () => {
    const options = buildLanguagePickerOptions('en', undefined, (tag) =>
      tag === 'ak' || tag === 'tw' ? 'Akan' : names(tag),
    );
    const akan = options.all.filter((option) => option.label.startsWith('Akan'));
    expect(akan).toEqual([
      { value: 'ak', label: 'Akan (ak)' },
      { value: 'tw', label: 'Akan (tw)' },
    ]);
    expect(options.all.find((option) => option.value === 'fr')?.label).toBe('French');
  });

  it('shows every real display name once', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const labels = buildLanguagePickerOptions(locale, undefined).all.map((option) => option.label);
      expect(new Set(labels).size, locale).toBe(labels.length);
    }
  });

  it('sorts real display names in the UI language and drops unnamed codes', () => {
    const options = buildLanguagePickerOptions('en', undefined);
    const labels = options.all.map((option) => option.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
    expect(options.all.every((option) => option.label !== option.value)).toBe(true);
    expect(options.all.some((option) => option.value === 'zh-Hant')).toBe(true);
    expect(options.all.some((option) => option.value === 'en')).toBe(true);
    expect(options.all.some((option) => option.value === 'zh-Hans')).toBe(false);
    expect(options.app.map((option) => option.value)).toEqual([...SUPPORTED_LOCALES]);
  });
});
