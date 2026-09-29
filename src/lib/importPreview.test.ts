import { describe, expect, it } from 'vitest';
import { importPreviewRules, translatedPreviewDraft } from './importPreview';
import type { RecipeDraft } from './types';

const base = {
  sourceLang: 'it' as string | undefined,
  uiLang: 'uk',
  translationFailed: false,
  pasted: false,
  translateChecked: true,
};

const recipe = (title: string, extra: Partial<RecipeDraft> = {}): RecipeDraft => ({
  title,
  servings: 2,
  ingredientSections: [],
  steps: [],
  tags: [],
  ...extra,
});

describe('importPreviewRules', () => {
  it('hides the checkbox when the languages match', () => {
    const rules = importPreviewRules({ ...base, sourceLang: 'en', uiLang: 'en-US' });
    expect(rules.showCheckbox).toBe(false);
    expect(rules.defaultChecked).toBe(false);
    expect(rules.showPastedHint).toBe(false);
    expect(rules.saveLang).toBe('en');
  });

  it('shows the checkbox checked by default when the languages differ', () => {
    const rules = importPreviewRules(base);
    expect(rules.showCheckbox).toBe(true);
    expect(rules.defaultChecked).toBe(true);
    expect(rules.saveLang).toBe('uk');
  });

  it('treats a missing guess and a bare zh as different', () => {
    expect(importPreviewRules({ ...base, sourceLang: undefined }).showCheckbox).toBe(true);
    expect(importPreviewRules({ ...base, sourceLang: undefined }).defaultChecked).toBe(true);
    expect(importPreviewRules({ ...base, sourceLang: 'zh', uiLang: 'zh-Hans' }).showCheckbox).toBe(true);
    expect(importPreviewRules({ ...base, sourceLang: 'zh-Hant', uiLang: 'zh-Hans' }).showCheckbox).toBe(true);
  });

  it('hides the checkbox when translation failed', () => {
    const rules = importPreviewRules({ ...base, translationFailed: true });
    expect(rules.showCheckbox).toBe(false);
    expect(rules.showPastedHint).toBe(false);
    expect(rules.saveLang).toBe('it');
  });

  it('saves the translation as the UI language and the original as sourceLang', () => {
    expect(importPreviewRules({ ...base, translateChecked: true }).saveLang).toBe('uk');
    expect(importPreviewRules({ ...base, translateChecked: false }).saveLang).toBe('it');
    expect(importPreviewRules({ ...base, sourceLang: undefined, translateChecked: false }).saveLang).toBeUndefined();
  });

  it('uses the pasted hint only, and keeps the same default for a URL', () => {
    const pasted = importPreviewRules({ ...base, pasted: true });
    const url = importPreviewRules({ ...base, pasted: false });
    expect(pasted.defaultChecked).toBe(true);
    expect(url.defaultChecked).toBe(true);
    expect(pasted.defaultChecked).toBe(url.defaultChecked);
    expect(pasted.showPastedHint).toBe(true);
    expect(url.showPastedHint).toBe(false);
    expect(pasted.saveLang).toBe(url.saveLang);
    expect(importPreviewRules({ ...base, pasted: true, translateChecked: false }).saveLang).toBe('it');
    expect(importPreviewRules({ ...base, pasted: true, sourceLang: 'uk', uiLang: 'uk' }).showPastedHint).toBe(false);
  });
});

describe('translatedPreviewDraft', () => {
  it('keeps the original link and photos on the translated text', () => {
    const draft = translatedPreviewDraft(
      recipe('Carbonara', { sourceUrl: 'https://example.com/x', lang: 'it', photoId: 'p1' }),
      recipe('Карбонара', { lang: 'uk' }),
    );
    expect(draft.title).toBe('Карбонара');
    expect(draft.sourceUrl).toBe('https://example.com/x');
    expect(draft.photoId).toBe('p1');
    expect(draft.lang).toBe('uk');
  });
});
