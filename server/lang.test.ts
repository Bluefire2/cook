import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as client from '../src/i18n/lang.ts';
import * as server from './lang.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type LangModule = typeof client;
const copies: [string, LangModule][] = [
  ['src/i18n/lang.ts', client],
  ['server/lang.ts', server],
];

const NORMALIZE_CASES: [unknown, string | undefined][] = [
  ['en', 'en'],
  ['EN', 'en'],
  ['en-GB', 'en'],
  ['en_US', 'en'],
  [' uk ', 'uk'],
  ['uk-UA', 'uk'],
  ['ua', 'uk'],
  ['UA', 'uk'],
  ['ua-UA', 'uk'],
  ['cn', 'zh'],
  ['jp', 'ja'],
  ['gr', 'el'],
  ['cz', 'cs'],
  ['dk', 'da'],
  ['se', 'sv'],
  ['zh', 'zh'],
  ['zh-CN', 'zh-Hans'],
  ['zh-cn', 'zh-Hans'],
  ['ZH-CN', 'zh-Hans'],
  ['zh-SG', 'zh-Hans'],
  ['zh-TW', 'zh-Hant'],
  ['zh-HK', 'zh-Hant'],
  ['zh-MO', 'zh-Hant'],
  ['zh-Hans', 'zh-Hans'],
  ['zh-hans', 'zh-Hans'],
  ['zh-Hant', 'zh-Hant'],
  ['zh-Hant-CN', 'zh-Hant'],
  ['zh-Hans-TW', 'zh-Hans'],
  ['zh-Hans-CN', 'zh-Hans'],
  ['cn-TW', 'zh-Hant'],
  ['sr-Latn', 'sr'],
  ['sr-Cyrl-RS', 'sr'],
  ['it-IT', 'it'],
  ['fr-CA', 'fr'],
  ['de-DE-1996', 'de'],
  ['iw', 'he'],
  ['', undefined],
  ['   ', undefined],
  ['garbage!!', undefined],
  ['123', undefined],
  ['x-private', undefined],
  ['english', undefined],
  [undefined, undefined],
  [null, undefined],
  [42, undefined],
  [{}, undefined],
];

const SAME_CASES: [unknown, unknown, client.LanguageComparison][] = [
  ['en', 'en', 'same'],
  ['en', 'en-GB', 'same'],
  ['uk', 'ua', 'same'],
  ['uk-UA', 'uk', 'same'],
  ['en', 'uk', 'different'],
  ['it', 'uk', 'different'],
  ['sr-Latn', 'sr-Cyrl', 'same'],
  ['zh-Hans', 'zh-Hans', 'same'],
  ['zh-CN', 'zh-Hans', 'same'],
  ['zh-Hans', 'zh-Hant', 'different'],
  ['zh-TW', 'zh-Hans', 'different'],
  ['zh', 'zh-Hans', 'unknown'],
  ['zh-Hans', 'zh', 'unknown'],
  ['zh', 'zh', 'unknown'],
  ['zh', 'en', 'different'],
  [undefined, 'en', 'unknown'],
  ['garbage!!', 'en', 'unknown'],
  ['en', null, 'unknown'],
];

describe.each(copies)('%s', (_name, lang) => {
  it.each(NORMALIZE_CASES)('normalizeLang(%j) is %j', (input, expected) => {
    expect(lang.normalizeLang(input)).toBe(expected);
  });

  it.each(SAME_CASES)('sameLanguage(%j, %j) is %s', (a, b, expected) => {
    expect(lang.sameLanguage(a, b)).toBe(expected);
  });

  it('lists the four UI languages', () => {
    expect(lang.SUPPORTED_LOCALES).toEqual(['en', 'uk', 'ru', 'zh-Hans']);
    expect(lang.DEFAULT_LOCALE).toBe('en');
  });

  it('isSupportedLocale accepts only the exact stored form', () => {
    expect(lang.isSupportedLocale('en')).toBe(true);
    expect(lang.isSupportedLocale('zh-Hans')).toBe(true);
    expect(lang.isSupportedLocale('zh-CN')).toBe(false);
    expect(lang.isSupportedLocale('zh')).toBe(false);
    expect(lang.isSupportedLocale('EN')).toBe(false);
    expect(lang.isSupportedLocale(undefined)).toBe(false);
  });

  it('toSupportedLocale normalizes first and keeps bare zh out (the UI default decides that)', () => {
    expect(lang.toSupportedLocale('zh-CN')).toBe('zh-Hans');
    expect(lang.toSupportedLocale('uk-UA')).toBe('uk');
    expect(lang.toSupportedLocale('ua')).toBe('uk');
    expect(lang.toSupportedLocale('en-GB')).toBe('en');
    expect(lang.toSupportedLocale('zh')).toBeUndefined();
    expect(lang.toSupportedLocale('zh-TW')).toBeUndefined();
    expect(lang.toSupportedLocale('it')).toBeUndefined();
    expect(lang.toSupportedLocale('garbage!!')).toBeUndefined();
  });

  it('primaryLanguage strips the script', () => {
    expect(lang.primaryLanguage('zh-Hans')).toBe('zh');
    expect(lang.primaryLanguage('uk')).toBe('uk');
  });
});

describe('client and server copies', () => {
  it('give identical results for every case', () => {
    for (const [input] of NORMALIZE_CASES) {
      expect(server.normalizeLang(input)).toBe(client.normalizeLang(input));
    }
    for (const [a, b] of SAME_CASES) {
      expect(server.sameLanguage(a, b)).toBe(client.sameLanguage(a, b));
    }
    expect(server.SUPPORTED_LOCALES).toEqual(client.SUPPORTED_LOCALES);
  });

  it('are the same source file', () => {
    const read = (path: string) =>
      readFileSync(join(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    expect(read('server/lang.ts')).toBe(read('src/i18n/lang.ts'));
  });
});
