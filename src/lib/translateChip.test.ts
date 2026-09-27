import { describe, expect, it } from 'vitest';
import { translateChipMode } from './translateChip';

describe('translateChipMode', () => {
  it('labels a recipe whose language differs from the UI', () => {
    expect(translateChipMode({ effectiveLang: 'it', uiLang: 'en' })).toBe('labelled');
  });

  it('hides the chip when the effective language matches the UI', () => {
    expect(translateChipMode({ effectiveLang: 'uk', uiLang: 'uk' })).toBe('hidden');
    expect(translateChipMode({ effectiveLang: 'zh-Hans', uiLang: 'zh-Hans' })).toBe('hidden');
  });

  it('keeps a labelled chip for a bare zh, which is unknown against zh-Hans', () => {
    expect(translateChipMode({ effectiveLang: 'zh', uiLang: 'zh-Hans' })).toBe('labelled');
  });

  it('uses the unlabelled chip when the recipe has no language', () => {
    expect(translateChipMode({ effectiveLang: undefined, uiLang: 'en' })).toBe('unlabelled');
  });

  it('shows loading and error from the latest tap', () => {
    expect(
      translateChipMode({ effectiveLang: 'it', uiLang: 'en', pending: 'loading' }),
    ).toBe('loading');
    expect(
      translateChipMode({ effectiveLang: undefined, uiLang: 'en', pending: 'error' }),
    ).toBe('error');
  });

  it('keeps the translated chip while that view is showing', () => {
    expect(
      translateChipMode({ effectiveLang: 'it', uiLang: 'en', viewingTranslation: true }),
    ).toBe('translated');
    expect(
      translateChipMode({
        effectiveLang: 'en',
        uiLang: 'en',
        viewingTranslation: true,
      }),
    ).toBe('translated');
  });
});
