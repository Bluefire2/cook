import { GenerateContentResponse, ThinkingLevel, type GenerateContentParameters } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSLATE_MODEL,
  DEFAULT_TRANSLATE_PROVIDER,
  TRANSLATE_FAILED,
  TRANSLATE_PROVIDER_UNAVAILABLE,
  detectLanguage,
  resolveTranslateConfig,
  translateMaxOutputTokens,
  translateSegments,
  translationPrompt,
  validateTranslatedSegments,
  type GeminiTranslateDeps,
  type TranslateSegment,
} from './translate.ts';

const SOURCE: TranslateSegment[] = [
  { id: 'title', text: 'Soup' },
  { id: 'step.0', text: 'Boil' },
];

function translatedReply(segments: TranslateSegment[], detectedLang = 'it'): unknown {
  return { detectedLang, segments };
}

function fakeDeps(reply: unknown): {
  deps: GeminiTranslateDeps;
  calls: GenerateContentParameters[];
} {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    deps: {
      model: DEFAULT_TRANSLATE_MODEL,
      ai: {
        models: {
          generateContent: (params) => {
            calls.push(params);
            const response = new GenerateContentResponse();
            response.candidates = [
              {
                content: {
                  role: 'model',
                  parts: [{ text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
                },
              },
            ];
            return Promise.resolve(response);
          },
        },
      },
    },
  };
}

describe('resolveTranslateConfig', () => {
  it('uses || so a blank provider or model selects the default', () => {
    expect(resolveTranslateConfig({})).toEqual({
      provider: DEFAULT_TRANSLATE_PROVIDER,
      model: DEFAULT_TRANSLATE_MODEL,
    });
    expect(resolveTranslateConfig({ TRANSLATE_PROVIDER: '', TRANSLATE_MODEL: '' })).toEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
    });
    expect(resolveTranslateConfig({ TRANSLATE_PROVIDER: 'nmt', TRANSLATE_MODEL: 'other' })).toEqual({
      provider: 'nmt',
      model: 'other',
    });
  });
});

describe('validateTranslatedSegments', () => {
  const ids = ['title', 'step.0'];
  const ok = [
    { id: 'title', text: 'Суп' },
    { id: 'step.0', text: 'Кип’ятити' },
  ];

  it('accepts the same ids once each in the same order', () => {
    expect(validateTranslatedSegments(ids, ok)).toEqual({ ok: true, segments: ok });
  });

  it('rejects a missing id', () => {
    const result = validateTranslatedSegments(ids, [ok[0]]);
    expect(result).toEqual({ ok: false });
    expect(result).not.toHaveProperty('segments');
  });

  it('rejects an extra id', () => {
    expect(validateTranslatedSegments(ids, [...ok, { id: 'extra', text: 'x' }])).toEqual({
      ok: false,
    });
  });

  it('rejects a reorder of the same ids', () => {
    expect(validateTranslatedSegments(ids, [ok[1], ok[0]])).toEqual({ ok: false });
  });

  it('rejects an empty string', () => {
    expect(
      validateTranslatedSegments(ids, [
        { id: 'title', text: '  ' },
        { id: 'step.0', text: 'Кип’ятити' },
      ]),
    ).toEqual({ ok: false });
  });
});

describe('translateSegments', () => {
  let savedProvider: string | undefined;
  let savedModel: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.TRANSLATE_PROVIDER;
    savedModel = process.env.TRANSLATE_MODEL;
  });

  afterEach(() => {
    if (savedProvider === undefined) {
      delete process.env.TRANSLATE_PROVIDER;
    } else {
      process.env.TRANSLATE_PROVIDER = savedProvider;
    }
    if (savedModel === undefined) {
      delete process.env.TRANSLATE_MODEL;
    } else {
      process.env.TRANSLATE_MODEL = savedModel;
    }
  });

  it('sends one structured call and normalizes detectedLang', async () => {
    const { deps, calls } = fakeDeps(
      translatedReply([
        { id: 'title', text: 'Суп' },
        { id: 'step.0', text: 'Кип’ятити' },
      ], 'it-IT'),
    );
    const outcome = await translateSegments(
      { segments: SOURCE, target: 'uk', sourceLang: 'it' },
      deps,
    );
    expect(outcome).toEqual({
      ok: true,
      detectedLang: 'it',
      segments: [
        { id: 'title', text: 'Суп' },
        { id: 'step.0', text: 'Кип’ятити' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(DEFAULT_TRANSLATE_MODEL);
    expect(calls[0].config?.responseMimeType).toBe('application/json');
    expect(calls[0].config?.responseSchema).toBeDefined();
    expect(calls[0].config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(calls[0].config).not.toHaveProperty('temperature');
    expect(calls[0].config?.maxOutputTokens).toBe(
      translateMaxOutputTokens(SOURCE[0].text.length + SOURCE[1].text.length, SOURCE.length),
    );
    const contents = calls[0].contents;
    expect(contents).toContain('Do not convert units.');
    expect(contents).toContain('Keep numbers, units, and temperatures exactly as written.');
    expect(contents).toContain('Keep "(?)" uncertainty markers exactly as written, including in notes.');
    expect(contents).toContain('Do not resolve a tablespoon-versus-teaspoon doubt. Leave it in notes.');
    expect(contents).toContain('Keep dish names recognisable.');
    expect(contents).toContain('Return exactly the ids given');
    expect(contents).toContain(translationPrompt({ target: 'uk', sourceLang: 'it', mode: 'translate' }));
  });

  it('treats an unusable detectedLang as null and still returns the segments', async () => {
    const { deps } = fakeDeps(
      translatedReply(
        [
          { id: 'title', text: 'Суп' },
          { id: 'step.0', text: 'Кип’ятити' },
        ],
        'not a language',
      ),
    );
    const outcome = await translateSegments({ segments: SOURCE, target: 'uk' }, deps);
    expect(outcome).toEqual({
      ok: true,
      detectedLang: null,
      segments: [
        { id: 'title', text: 'Суп' },
        { id: 'step.0', text: 'Кип’ятити' },
      ],
    });
  });

  it('fails the whole call when ids are reordered', async () => {
    const { deps } = fakeDeps({
      detectedLang: 'it',
      segments: [
        { id: 'step.0', text: 'Кип’ятити' },
        { id: 'title', text: 'Суп' },
      ],
    });
    const outcome = await translateSegments({ segments: SOURCE, target: 'uk' }, deps);
    expect(outcome).toEqual({ ok: false, code: TRANSLATE_FAILED });
  });

  it('fails closed for an unknown provider without calling Gemini', async () => {
    process.env.TRANSLATE_PROVIDER = 'nmt';
    let called = false;
    const deps: GeminiTranslateDeps = {
      model: 'unused',
      ai: {
        models: {
          generateContent: () => {
            called = true;
            return Promise.reject(new Error('should not be called'));
          },
        },
      },
    };
    const outcome = await translateSegments({ segments: SOURCE, target: 'uk' }, deps);
    expect(outcome).toEqual({ ok: false, code: TRANSLATE_PROVIDER_UNAVAILABLE });
    expect(called).toBe(false);
  });

  it('maps a provider throw to translate-failed', async () => {
    const deps: GeminiTranslateDeps = {
      model: DEFAULT_TRANSLATE_MODEL,
      ai: {
        models: {
          generateContent: () => Promise.reject(new Error('down')),
        },
      },
    };
    const outcome = await translateSegments({ segments: SOURCE, target: 'en' }, deps);
    expect(outcome).toEqual({ ok: false, code: TRANSLATE_FAILED });
  });
});

describe('detectLanguage', () => {
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.TRANSLATE_PROVIDER;
  });

  afterEach(() => {
    if (savedProvider === undefined) {
      delete process.env.TRANSLATE_PROVIDER;
    } else {
      process.env.TRANSLATE_PROVIDER = savedProvider;
    }
  });

  it('returns a normalized tag', async () => {
    const { deps, calls } = fakeDeps({
      detectedLang: 'zh-CN',
      segments: [{ id: 'text', text: '面条' }],
    });
    expect(await detectLanguage('  面条  ', deps)).toBe('zh-Hans');
    expect(calls).toHaveLength(1);
    expect(calls[0].contents).toContain('Detect the language');
  });

  it('returns null for an empty string without calling Gemini', async () => {
    let called = false;
    const deps: GeminiTranslateDeps = {
      model: DEFAULT_TRANSLATE_MODEL,
      ai: {
        models: {
          generateContent: () => {
            called = true;
            return Promise.reject(new Error('should not be called'));
          },
        },
      },
    };
    expect(await detectLanguage('   ', deps)).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when the provider is not gemini', async () => {
    process.env.TRANSLATE_PROVIDER = 'nmt';
    let called = false;
    const deps: GeminiTranslateDeps = {
      model: DEFAULT_TRANSLATE_MODEL,
      ai: {
        models: {
          generateContent: () => {
            called = true;
            return Promise.reject(new Error('should not be called'));
          },
        },
      },
    };
    expect(await detectLanguage('Carbonara', deps)).toBeNull();
    expect(called).toBe(false);
  });
});
