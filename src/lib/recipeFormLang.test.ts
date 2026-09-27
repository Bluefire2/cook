import { describe, expect, it } from 'vitest';
import { fromDraft, toDraft } from '../components/RecipeForm';
import { blankDraft } from './recipeDraft';
import { defaultRecipeFormLang, detectedLangHint } from './recipeFormLang';

describe('defaultRecipeFormLang', () => {
  it('uses the UI locale when the recipe has no lang and keeps a stored tag', () => {
    expect(defaultRecipeFormLang(undefined, 'uk')).toBe('uk');
    expect(defaultRecipeFormLang('it', 'uk')).toBe('it');
    expect(defaultRecipeFormLang('yue', 'en')).toBe('yue');
  });

  it('pre-fills a missing lang from a detection and does not overwrite a stored tag', () => {
    expect(defaultRecipeFormLang(undefined, 'uk', 'it')).toBe('it');
    expect(defaultRecipeFormLang('it', 'uk', 'en')).toBe('it');
    expect(defaultRecipeFormLang(undefined, 'uk', undefined)).toBe('uk');
  });
});

describe('detectedLangHint', () => {
  it('offers a detection that disagrees and stays quiet when it matches or is missing', () => {
    expect(detectedLangHint('it', 'en')).toBe('en');
    expect(detectedLangHint('zh-Hans', 'zh')).toBe('zh');
    expect(detectedLangHint('it', 'it')).toBeUndefined();
    expect(detectedLangHint('en', 'en-US')).toBeUndefined();
    expect(detectedLangHint(undefined, 'it')).toBeUndefined();
    expect(detectedLangHint('it', undefined)).toBeUndefined();
  });
});

describe('recipe form lang through fromDraft and toDraft', () => {
  it('includes the UI language on a new recipe', () => {
    const initial = blankDraft();
    const form = fromDraft(initial, 'zh-Hans');
    expect(form.lang).toBe('zh-Hans');
    expect(toDraft(form, initial, undefined, []).lang).toBe('zh-Hans');
  });

  it('round-trips a stored lang, including a tag the picker does not list', () => {
    const initial = { ...blankDraft(), title: 'Soup', lang: 'yue' };
    const form = fromDraft(initial, 'en');
    expect(form.lang).toBe('yue');
    const saved = toDraft({ ...form, title: 'Soups' }, initial, undefined, []);
    expect(saved.lang).toBe('yue');
    expect(saved.title).toBe('Soups');
  });

  it('omits lang when Unknown clears the field', () => {
    const initial = { ...blankDraft(), lang: 'it' };
    const form = fromDraft(initial, 'en');
    const saved = toDraft({ ...form, lang: undefined }, initial, undefined, []);
    expect(saved.lang).toBeUndefined();
    expect('lang' in saved).toBe(false);
  });

  it('pre-fills a missing lang from a detection passed into fromDraft', () => {
    const unlabelled = blankDraft();
    expect(fromDraft(unlabelled, 'uk', 'it').lang).toBe('it');
    const labelled = { ...blankDraft(), lang: 'it' };
    expect(fromDraft(labelled, 'uk', 'en').lang).toBe('it');
    expect(toDraft(fromDraft(labelled, 'uk', 'en'), labelled, undefined, []).lang).toBe('it');
  });

  it('does not invent a language when the field is hidden', () => {
    const unlabelled = blankDraft();
    expect(fromDraft(unlabelled, undefined).lang).toBeUndefined();
    expect(toDraft(fromDraft(unlabelled, undefined), unlabelled, undefined, []).lang).toBeUndefined();

    const labelled = { ...blankDraft(), lang: 'it' };
    expect(fromDraft(labelled, undefined).lang).toBe('it');
  });
});
