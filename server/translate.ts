/**
 * Translation provider. This branch accepts only Gemini
 * (`gemini-3.5-flash-lite`, thinking level minimal, default temperature).
 * Any other `TRANSLATE_PROVIDER` fails closed. The client is injected, the
 * same way `recipeImport` injects its client, so tests never call the network.
 * Env is read per call. `||` not `??`: a bare `TRANSLATE_MODEL=` is `''`.
 */
import { GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';
import { normalizeLang } from './lang.ts';

export const DEFAULT_TRANSLATE_PROVIDER = 'gemini';
export const DEFAULT_TRANSLATE_MODEL = 'gemini-3.5-flash-lite';

export const TRANSLATE_PROVIDER_UNAVAILABLE = 'translate-provider-unavailable';
export const TRANSLATE_FAILED = 'translate-failed';

export interface TranslateSegment {
  id: string;
  text: string;
}

export interface TranslateInput {
  segments: readonly TranslateSegment[];
  target: string;
  sourceLang?: string;
}

export interface GeminiTranslateDeps {
  /** Only `models.generateContent` is used; fakes implement exactly this. */
  ai: { models: Pick<GoogleGenAI['models'], 'generateContent'> };
  model: string;
}

export type TranslateOutcome =
  | { ok: true; detectedLang: string | null; segments: TranslateSegment[] }
  | { ok: false; code: typeof TRANSLATE_PROVIDER_UNAVAILABLE | typeof TRANSLATE_FAILED };

const TARGET_LANGUAGE_NAME: Readonly<Record<string, string>> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
  'zh-Hans': 'Simplified Chinese',
};

const TRANSLATE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    detectedLang: {
      type: Type.STRING,
      description: 'BCP 47 language tag of the source text, such as "it" or "zh-Hans".',
    },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          text: { type: Type.STRING },
        },
        required: ['id', 'text'],
      },
    },
  },
  required: ['detectedLang', 'segments'],
};

export interface TranslateEnv {
  TRANSLATE_PROVIDER?: string;
  TRANSLATE_MODEL?: string;
}

/** Per-call provider and model. Blank strings select the defaults (`||`). */
export function resolveTranslateConfig(env: TranslateEnv): { provider: string; model: string } {
  return {
    provider: env.TRANSLATE_PROVIDER || DEFAULT_TRANSLATE_PROVIDER,
    model: env.TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL,
  };
}

export function geminiTranslateDepsFromEnv():
  | { ok: true; deps: GeminiTranslateDeps }
  | { ok: false; code: 'translate-unavailable' } {
  const apiKey = process.env.GEMINI_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return { ok: false, code: 'translate-unavailable' };
  }
  return {
    ok: true,
    deps: {
      ai: new GoogleGenAI({ apiKey }),
      model: resolveTranslateConfig(process.env).model,
    },
  };
}

/**
 * Output budget for one structured call. Grows with the request and stays
 * within the model's output-token limit.
 */
export function translateMaxOutputTokens(charCount: number, segmentCount: number): number {
  const estimate = 512 + segmentCount * 48 + charCount * 3;
  return Math.min(65_536, Math.max(1_024, estimate));
}

export function translationPrompt(input: {
  target: string;
  sourceLang?: string;
  mode: 'translate' | 'detect';
}): string {
  if (input.mode === 'detect') {
    return [
      'Detect the language of this cooking text.',
      'Return detectedLang as a BCP 47 language tag (for example "it" or "zh-Hans").',
      'Return each segment text unchanged.',
      'Return exactly the ids given, once each, in the same order.',
    ].join('\n');
  }
  const targetName = TARGET_LANGUAGE_NAME[input.target] ?? input.target;
  const lines = [
    `Translate each segment of this cooking text into ${targetName}.`,
    'Keep numbers, units, and temperatures exactly as written.',
    'Do not convert units.',
    'Keep "(?)" uncertainty markers exactly as written, including in notes.',
    'Do not resolve a tablespoon-versus-teaspoon doubt. Leave it in notes.',
    'Keep dish names recognisable.',
    'Return exactly the ids given, once each, in the same order.',
    'Return detectedLang as a BCP 47 language tag for the language the source text is actually written in, judged from the text alone.',
  ];
  if (input.sourceLang !== undefined) {
    // A hint only. Live tests showed the model echoing a hint into
    // detectedLang when the text was already in the target language.
    lines.push(
      `A caller hint says the source may be ${input.sourceLang}. It can be wrong: use it only to help translate, never as detectedLang unless the text confirms it.`,
    );
  }
  return lines.join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Same ids, once each, same order, non-empty strings. Anything else is an
 * error and carries no segments, so nothing is partly applied.
 */
export function validateTranslatedSegments(
  expectedIds: readonly string[],
  actual: unknown,
): { ok: true; segments: TranslateSegment[] } | { ok: false } {
  if (!Array.isArray(actual) || actual.length !== expectedIds.length) {
    return { ok: false };
  }
  const segments: TranslateSegment[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < expectedIds.length; index += 1) {
    const row = actual[index];
    if (!isPlainObject(row) || typeof row.id !== 'string' || typeof row.text !== 'string') {
      return { ok: false };
    }
    if (row.id !== expectedIds[index] || seen.has(row.id) || row.text.trim() === '') {
      return { ok: false };
    }
    seen.add(row.id);
    segments.push({ id: row.id, text: row.text });
  }
  return { ok: true, segments };
}

function segmentCharCount(segments: readonly TranslateSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    total += segment.text.length;
  }
  return total;
}

async function geminiTranslate(
  input: TranslateInput,
  deps: GeminiTranslateDeps,
  mode: 'translate' | 'detect',
): Promise<TranslateOutcome> {
  if (input.segments.length === 0) {
    return { ok: true, detectedLang: null, segments: [] };
  }
  const prompt = translationPrompt({
    target: input.target,
    sourceLang: input.sourceLang,
    mode,
  });
  const contents = `${prompt}\n\nSegments:\n${JSON.stringify(input.segments)}`;
  let text: string | undefined;
  try {
    const result = await deps.ai.models.generateContent({
      model: deps.model,
      contents,
      config: {
        maxOutputTokens: translateMaxOutputTokens(
          segmentCharCount(input.segments),
          input.segments.length,
        ),
        responseMimeType: 'application/json',
        responseSchema: TRANSLATE_SCHEMA,
        // Gemini 3 thinking level `minimal`. Temperature stays at the default.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    text = result.text;
  } catch {
    return { ok: false, code: TRANSLATE_FAILED };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    return { ok: false, code: TRANSLATE_FAILED };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: TRANSLATE_FAILED };
  }
  const validated = validateTranslatedSegments(
    input.segments.map((segment) => segment.id),
    parsed.segments,
  );
  if (!validated.ok) {
    return { ok: false, code: TRANSLATE_FAILED };
  }
  return {
    ok: true,
    detectedLang: normalizeLang(parsed.detectedLang) ?? null,
    segments: validated.segments,
  };
}

export async function translateSegments(
  input: TranslateInput,
  deps: GeminiTranslateDeps,
): Promise<TranslateOutcome> {
  if (resolveTranslateConfig(process.env).provider !== DEFAULT_TRANSLATE_PROVIDER) {
    return { ok: false, code: TRANSLATE_PROVIDER_UNAVAILABLE };
  }
  return geminiTranslate(input, deps, 'translate');
}

/** A tag, or `null` when the text is empty, the provider is unavailable, or detection fails. */
export async function detectLanguage(
  text: string,
  deps: GeminiTranslateDeps,
): Promise<string | null> {
  if (resolveTranslateConfig(process.env).provider !== DEFAULT_TRANSLATE_PROVIDER) {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const outcome = await geminiTranslate(
    { segments: [{ id: 'text', text: trimmed }], target: 'en' },
    deps,
    'detect',
  );
  if (!outcome.ok) {
    return null;
  }
  return outcome.detectedLang;
}
