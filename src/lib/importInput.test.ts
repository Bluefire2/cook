import { describe, expect, it } from 'vitest';
import {
  BULK_CAP_ERROR,
  BULK_LINKS_ONLY,
  BULK_REQUIRES_CHECKBOX,
  MAX_BULK_IMPORT_URLS,
  parseImportInput,
  validateImportInput,
} from './importInput';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';
const URL_C = 'http://example.com/c?x=1';

describe('parseImportInput', () => {
  it('is empty for blank or whitespace-only input', () => {
    expect(parseImportInput('')).toEqual({ kind: 'empty' });
    expect(parseImportInput('  \n\t  ')).toEqual({ kind: 'empty' });
  });

  it('is singleUrl for one http(s) token', () => {
    expect(parseImportInput(URL_A)).toEqual({ kind: 'singleUrl', url: URL_A });
    expect(parseImportInput(`  ${URL_C}  `)).toEqual({
      kind: 'singleUrl',
      url: URL_C,
    });
  });

  it('is urlList for two or more URL tokens, split on any whitespace', () => {
    expect(parseImportInput(`${URL_A}\n${URL_B}`)).toEqual({
      kind: 'urlList',
      urls: [URL_A, URL_B],
    });
    expect(parseImportInput(`${URL_A} ${URL_B}`)).toEqual({
      kind: 'urlList',
      urls: [URL_A, URL_B],
    });
    expect(parseImportInput(`${URL_A}\n\n${URL_B}\t${URL_C}`)).toEqual({
      kind: 'urlList',
      urls: [URL_A, URL_B, URL_C],
    });
  });

  it('dedupes exact repeats and keeps first-seen order', () => {
    expect(parseImportInput(`${URL_A}\n${URL_B}\n${URL_A}`)).toEqual({
      kind: 'urlList',
      urls: [URL_A, URL_B],
    });
    expect(parseImportInput(`${URL_A}\n${URL_A}`)).toEqual({
      kind: 'singleUrl',
      url: URL_A,
    });
  });

  it('is text when any token is not a URL', () => {
    expect(parseImportInput('Ingredients:\nflour')).toEqual({
      kind: 'text',
      text: 'Ingredients:\nflour',
    });
    expect(parseImportInput(`${URL_A} and ${URL_B}`)).toEqual({
      kind: 'text',
      text: `${URL_A} and ${URL_B}`,
    });
    expect(parseImportInput('www.example.com/recipe')).toEqual({
      kind: 'text',
      text: 'www.example.com/recipe',
    });
  });
});

describe('validateImportInput', () => {
  it('rejects urlList when bulk is off', () => {
    const parsed = parseImportInput(`${URL_A}\n${URL_B}`);
    expect(validateImportInput(parsed, false)).toEqual({
      ok: false,
      error: BULK_REQUIRES_CHECKBOX,
    });
  });

  it('rejects text when bulk is on', () => {
    const parsed = parseImportInput('Ingredients:\nflour');
    expect(validateImportInput(parsed, true)).toEqual({
      ok: false,
      error: BULK_LINKS_ONLY,
    });
  });

  it('rejects urlList over the cap when bulk is on', () => {
    const urls = Array.from(
      { length: MAX_BULK_IMPORT_URLS + 1 },
      (_, i) => `https://example.com/r${i}`,
    );
    const parsed = parseImportInput(urls.join('\n'));
    expect(validateImportInput(parsed, true)).toEqual({
      ok: false,
      error: BULK_CAP_ERROR,
    });
  });

  it('accepts urlList at the cap when bulk is on', () => {
    const urls = Array.from(
      { length: MAX_BULK_IMPORT_URLS },
      (_, i) => `https://example.com/r${i}`,
    );
    const parsed = parseImportInput(urls.join('\n'));
    expect(validateImportInput(parsed, true)).toEqual({
      ok: true,
      mode: 'bulk',
      urls,
    });
  });

  it('accepts two URLs as bulk when the checkbox is on', () => {
    const parsed = parseImportInput(`${URL_A}\n${URL_B}`);
    expect(validateImportInput(parsed, true)).toEqual({
      ok: true,
      mode: 'bulk',
      urls: [URL_A, URL_B],
    });
  });

  it('keeps a single URL on the preview path even when bulk is on', () => {
    const parsed = parseImportInput(URL_A);
    expect(validateImportInput(parsed, true)).toEqual({
      ok: true,
      mode: 'url',
      url: URL_A,
    });
    expect(validateImportInput(parsed, false)).toEqual({
      ok: true,
      mode: 'url',
      url: URL_A,
    });
  });

  it('keeps mixed prose and links as paste when bulk is off', () => {
    const parsed = parseImportInput(`See ${URL_A} and ${URL_B}`);
    expect(validateImportInput(parsed, false)).toEqual({
      ok: true,
      mode: 'text',
      text: `See ${URL_A} and ${URL_B}`,
    });
  });

  it('returns an empty error for empty input', () => {
    expect(validateImportInput({ kind: 'empty' }, false)).toEqual({
      ok: false,
      error: '',
    });
  });
});
