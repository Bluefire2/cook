/**
 * Recipe import: page HTML, pasted text, or photos in, a saveable recipe draft out.
 *
 * The one pipeline behind `POST /api/import` (`server/importRoute.ts`),
 * `POST /api/extension/import` (`server/extensionImport.ts`) and the live
 * import evals (`evals/recipeImport.eval.ts`). Callers enter through
 * `importFromHtml`, `importFromSource`, or `importFromImages`. Nothing here
 * knows about HTTP: routes map `ImportOutcome` / `PageFetchOutcome` to statuses
 * and copy. The Gemini client and model are passed in; `recipeImportDepsFromEnv`
 * is the only place that reads the environment. Translation uses the injected
 * `translator` (`translateSegments`); a failure there never fails the import.
 *
 * Photo import is bound by `docs/constitutions/image-import.md`.
 */
import { GoogleGenAI, MediaResolution, Type, type Schema } from '@google/genai';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { normalizeLang, sameLanguage, toSupportedLocale, type Locale } from './lang.ts';
import { applyTranslation, recipeSegments, translationExceedsCaps } from './recipeTranslation.ts';
import {
  TRANSLATE_FAILED,
  geminiTranslateDepsFromEnv,
  translateSegments,
  validateTranslatedSegments,
  type TranslateInput,
  type TranslateOutcome,
} from './translate.ts';

export interface ImportedIngredient {
  quantity?: number;
  unit?: string;
  item: string;
  note?: string;
}

export interface ImportedIngredientSection {
  name?: string;
  items: ImportedIngredient[];
}

/** Structurally a `RecipeDraft` (src/lib/types.ts) without sourceUrl or photos. */
export interface ImportedRecipe {
  title: string;
  servings: number;
  ingredientSections: ImportedIngredientSection[];
  steps: { text: string }[];
  tags: string[];
  description?: string;
  notes?: string;
  prepMinutes?: number;
  cookMinutes?: number;
  /** Canonical BCP 47 tag, when the source language could be normalized. */
  lang?: string;
}

/**
 * Bound `translateSegments`: the same input and outcome, with the provider
 * client already applied. Fakes implement this and must not call the network.
 * A missing key or unavailable provider resolves to `{ ok: false }`; it does
 * not throw.
 */
export type RecipeTranslator = (input: TranslateInput) => Promise<TranslateOutcome>;

/**
 * One photo: raw base64 with no data-URL prefix, the same shape as
 * `ChatRequestImage`. `importFromImages` trusts it, so callers validate first
 * (`checkImportImages` in `server/importRoute.ts`).
 */
export interface ImportImage {
  mediaType: string;
  base64: string;
}

export interface RecipeImportDeps {
  /** Only `models.generateContent` is used; fakes implement exactly this. */
  ai: { models: Pick<GoogleGenAI['models'], 'generateContent'> };
  model: string;
  translator: RecipeTranslator;
}

export const IMPORT_BAD_LANGUAGE_CODE = 'import-bad-language';
export const IMPORT_BAD_LANGUAGE_ERROR = 'That language is not supported.';

/**
 * Absent is allowed. A present value must normalize to a supported UI
 * language (`ua` → `uk`, `zh-CN` → `zh-Hans`). Anything else is rejected.
 */
export function readImportTranslateTo(
  value: unknown,
): { ok: true; translateTo?: Locale } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  const translateTo = toSupportedLocale(value);
  if (translateTo === undefined) {
    return { ok: false };
  }
  return { ok: true, translateTo };
}

export type ImportTranslation =
  | { kind: 'ok'; lang: string; recipe: ImportedRecipe }
  | { kind: 'failed' };

export type ImportOutcome =
  | { kind: 'ok'; recipe: ImportedRecipe; translation?: ImportTranslation }
  /** Nothing to send; Gemini is not called. */
  | { kind: 'empty_source' }
  /** The model reported that the source holds no recipe. */
  | { kind: 'not_a_recipe' }
  /** The model's output was not a JSON object. */
  | { kind: 'parse_error' }
  /** JSON, but `normalizeImportedRecipe` could not make a recipe of it. */
  | { kind: 'unusable' };

export type PageFetchOutcome =
  | { kind: 'ok'; html: string }
  | { kind: 'invalid_url' }
  | { kind: 'unsupported_scheme' }
  | { kind: 'unreachable' }
  | { kind: 'refused'; status: number };

const DEFAULT_MODEL = 'gemini-3.7-flash';

const MAX_SOURCE_CHARS = 60000;

// NOTE: `api/chat.ts` still carries its own copy of this schema for
// `update_recipe`. Keep the two in sync until chat gets the same treatment,
// except `lang`: it is import-only and must not be copied into `api/chat.ts`.
const RECIPE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    description: { type: Type.STRING, description: 'One or two sentences.' },
    servings: { type: Type.NUMBER },
    prepMinutes: { type: Type.NUMBER },
    cookMinutes: { type: Type.NUMBER },
    ingredientSections: {
      type: Type.ARRAY,
      description:
        'Use a single unnamed section unless the recipe clearly has component groups like "Sauce" and "Dough".',
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quantity: { type: Type.NUMBER, description: 'e.g. 0.5 for ½' },
                unit: {
                  type: Type.STRING,
                  description:
                    'Prefer one of: piece, tsp, tbsp, cup, ml, l, g, kg, oz, lb. Use "piece" for countable items when a unit reads naturally; omit the unit entirely for items counted without one. If none of these fit, use a short lowercase unit.',
                },
                item: { type: Type.STRING, description: 'The ingredient itself' },
                note: { type: Type.STRING, description: 'e.g. "thinly sliced"' },
              },
              required: ['item'],
            },
          },
        },
        required: ['items'],
      },
    },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING } },
        required: ['text'],
      },
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2-4 short lowercase tags like "pasta", "weeknight".',
    },
    notes: { type: Type.STRING, description: 'Tips or variations worth keeping.' },
    lang: {
      type: Type.STRING,
      description:
        'BCP 47 language tag of the source recipe, such as "it" or "zh-Hans". Omit if you cannot tell.',
    },
  },
  required: ['title', 'servings', 'ingredientSections', 'steps', 'tags'],
};

const RECIPE_OUTPUT_CONFIG = {
  maxOutputTokens: 4096,
  responseMimeType: 'application/json',
  responseSchema: RECIPE_SCHEMA,
};

type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlParent = DefaultTreeAdapterMap['parentNode'];

function isHtmlElement(node: DefaultTreeAdapterMap['childNode']): node is HtmlElement {
  return 'tagName' in node;
}

function attributeValue(element: HtmlElement, name: string): string | undefined {
  for (const attr of element.attrs) {
    if (attr.name === name) return attr.value;
  }
  return undefined;
}

/** `type` equals `application/ld+json` after trim, case-insensitively. Extra tokens do not count. */
function isLdJsonScript(element: HtmlElement): boolean {
  if (element.tagName !== 'script') return false;
  const type = attributeValue(element, 'type');
  return type !== undefined && type.trim().toLowerCase() === 'application/ld+json';
}

/** `role` equals `main` after trim, case-insensitively. `main-content` does not count. */
function isMainRole(element: HtmlElement): boolean {
  const role = attributeValue(element, 'role');
  return role !== undefined && role.trim().toLowerCase() === 'main';
}

/** Original-HTML span of an element. Implied nodes the parser invented have no location. */
function elementSource(html: string, element: HtmlElement): string | null {
  const loc = element.sourceCodeLocation;
  if (!loc) return null;
  return html.slice(loc.startOffset, loc.endOffset);
}

/**
 * Raw script text, from the end of the start tag to the start of the end tag.
 * An unclosed `<script>` has no end tag and is not a JSON-LD candidate.
 */
function scriptRawText(html: string, element: HtmlElement): string | null {
  const loc = element.sourceCodeLocation;
  if (!loc?.startTag || !loc.endTag) return null;
  return html.slice(loc.startTag.endOffset, loc.endTag.startOffset);
}

/** Elements in source order, including the contents of `<template>`. Comments are not elements. */
function walkElements(parent: HtmlParent, visit: (element: HtmlElement) => void): void {
  for (const child of parent.childNodes) {
    if (!isHtmlElement(child)) continue;
    visit(child);
    if (child.tagName === 'template') {
      walkElements((child as DefaultTreeAdapterMap['template']).content, visit);
    }
    walkElements(child, visit);
  }
}

/** Script and style bodies still count; this is not `stripToText`. */
function regionTextLength(region: string): number {
  return region.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

/** Equal lengths keep the earlier slice (`len > bestLen`). */
function longestSlice(regions: string[]): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const region of regions) {
    const len = regionTextLength(region);
    if (len > bestLen) {
      best = region;
      bestLen = len;
    }
  }
  return best;
}

/**
 * News-article recipes live in these regions, often after a long nav that
 * would eat the 60k text cap. The longest `<article>` wins, so a header
 * teaser or a nested related-story card does not replace the story.
 * A short article beside a larger `<main>` / `role="main"` yields to that
 * region. Slices are the original HTML, not parser text.
 */
function primaryRegion(html: string, articles: string[], mains: string[]): string {
  const article = longestSlice(articles);
  const main = longestSlice(mains);
  if (article && main) {
    if (regionTextLength(article) * 2 >= regionTextLength(main)) return article;
    return main;
  }
  return article ?? main ?? html;
}

/**
 * Tag strip for the text fallback, run on a slice of the original HTML.
 * A `>` inside a quoted attribute still ends `<[^>]+>` early, so the rest
 * of that attribute can leak into the text.
 */
function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_SOURCE_CHARS);
}

function collectedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectedText).join(' ');
  if (value && typeof value === 'object') {
    const row = value as { text?: unknown; name?: unknown };
    return `${collectedText(row.text)} ${collectedText(row.name)}`;
  }
  return '';
}

/**
 * A Recipe node that lists ingredients or steps but leaves them blank (Maangchi
 * publishes `recipeIngredient: []` and HowToSteps with only a position) is not
 * a recipe. A node that omits both fields is left alone: older fixtures and
 * partial blocks still go to Gemini as JSON-LD.
 */
function recipeJsonLdHasBody(node: object): boolean {
  const row = node as { recipeIngredient?: unknown; recipeInstructions?: unknown };
  const listsIngredients = Object.prototype.hasOwnProperty.call(node, 'recipeIngredient');
  const listsInstructions = Object.prototype.hasOwnProperty.call(node, 'recipeInstructions');
  if (!listsIngredients && !listsInstructions) return true;
  return (
    collectedText(row.recipeIngredient).trim() !== '' ||
    collectedText(row.recipeInstructions).trim() !== ''
  );
}

/**
 * Recipe JSON-LD fields that say nothing about how to make the dish: reader
 * reviews and comments, ratings, and media. Dropped only when a node is over
 * the cap, where a site's review list would otherwise push the recipe's own
 * fields out and leave Gemini an unterminated object.
 */
const NON_RECIPE_JSON_LD_KEYS = [
  'review',
  'comment',
  'aggregateRating',
  'interactionStatistic',
  'video',
];

function recipeNodeSource(node: object): string {
  const full = JSON.stringify(node);
  if (full.length <= MAX_SOURCE_CHARS) return full;
  const trimmed: Record<string, unknown> = { ...node };
  for (const key of NON_RECIPE_JSON_LD_KEYS) delete trimmed[key];
  return JSON.stringify(trimmed).slice(0, MAX_SOURCE_CHARS);
}

/**
 * Prefers the schema.org/Recipe JSON-LD block most recipe sites embed
 * (compact and unambiguous); falls back to the page's stripped text,
 * preferring `<article>` / `<main>` so a news-article recipe is not lost
 * behind nav chrome. An empty Recipe block does not count. The `type`
 * attribute may be unquoted (`type=application/ld+json`), which HTML allows
 * and minifiers emit. `@graph` is unwrapped one level. A short article
 * yields to a larger `<main>` or `role="main"`.
 *
 * parse5 (with source locations) finds the script bodies and the region
 * slices. Both are cut from the original HTML. A Recipe that exists only
 * inside a comment does not win, because a comment is not an element.
 */
export function extractRecipeSource(html: string): string {
  const scripts: string[] = [];
  const articles: string[] = [];
  const mains: string[] = [];
  walkElements(parse(html, { sourceCodeLocationInfo: true }), (element) => {
    if (isLdJsonScript(element)) {
      const body = scriptRawText(html, element);
      if (body !== null) scripts.push(body);
      return;
    }
    const slice = elementSource(html, element);
    if (slice === null) return;
    if (element.tagName === 'article') articles.push(slice);
    if (element.tagName === 'main' || isMainRole(element)) mains.push(slice);
  });

  for (const block of scripts) {
    try {
      const parsed: unknown = JSON.parse(block);
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : ((parsed as { '@graph'?: unknown[] })['@graph'] ?? [parsed]);
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const type = (node as { '@type'?: string | string[] })['@type'];
        const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
        if (isRecipe && recipeJsonLdHasBody(node)) {
          return recipeNodeSource(node);
        }
      }
    } catch {
      // Malformed JSON-LD — keep looking.
    }
  }

  return stripToText(primaryRegion(html, articles, mains));
}

/** Website URL path only. The Chrome extension sends the tab HTML instead. */
export async function fetchPageHtml(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageFetchOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: 'invalid_url' };
  }
  // Scheme check only (matches RecipeView's http/https allowlist); does not block private or link-local destinations.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'unsupported_scheme' };
  }

  let page: Response;
  try {
    page = await fetchImpl(parsed.href, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (!page.ok) {
    return { kind: 'refused', status: page.status };
  }
  return { kind: 'ok', html: await page.text() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeIngredient(item: unknown): ImportedIngredient | undefined {
  if (!isPlainObject(item)) return undefined;
  const itemText = nonEmptyString(item.item);
  if (itemText === undefined) return undefined;
  const result: ImportedIngredient = { item: itemText };
  const quantity = finiteNumber(item.quantity);
  if (quantity !== undefined) result.quantity = quantity;
  const unit = nonEmptyString(item.unit);
  if (unit !== undefined) result.unit = unit;
  const note = nonEmptyString(item.note);
  if (note !== undefined) result.note = note;
  return result;
}

function normalizeIngredientSections(value: unknown): ImportedIngredientSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ImportedIngredientSection[] = [];
  for (const section of value) {
    if (!isPlainObject(section)) continue;
    const items = (Array.isArray(section.items) ? section.items : [])
      .map(normalizeIngredient)
      .filter((item): item is ImportedIngredient => item !== undefined);
    if (items.length === 0) continue;
    const name = nonEmptyString(section.name);
    sections.push(name !== undefined ? { name, items } : { items });
  }
  return sections;
}

function normalizeSteps(value: unknown): { text: string }[] {
  if (!Array.isArray(value)) return [];
  const steps: { text: string }[] = [];
  for (const step of value) {
    if (!isPlainObject(step)) continue;
    const text = nonEmptyString(step.text);
    if (text !== undefined) steps.push({ text });
  }
  return steps;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    const trimmed = nonEmptyString(tag);
    if (trimmed !== undefined && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}

/**
 * Repairs what can be repaired of a model's output and returns `null` when it
 * cannot be saved at all. `title` is the only field with no sensible repair;
 * everything else is normalized or dropped. Unknown keys never survive.
 */
export function normalizeImportedRecipe(raw: unknown): ImportedRecipe | null {
  if (!isPlainObject(raw)) return null;

  const title = nonEmptyString(raw.title);
  if (title === undefined) return null;

  // A missing or nonsensical serving count would break the recipe view's
  // scaler, and bulk and extension imports save without review. One serving
  // is wrong but usable, and editable in the app.
  const servings = finiteNumber(raw.servings);

  const recipe: ImportedRecipe = {
    title,
    servings: servings === undefined || servings < 1 ? 1 : servings,
    ingredientSections: normalizeIngredientSections(raw.ingredientSections),
    steps: normalizeSteps(raw.steps),
    tags: normalizeTags(raw.tags),
  };

  const description = nonEmptyString(raw.description);
  if (description !== undefined) recipe.description = description;

  const notes = nonEmptyString(raw.notes);
  if (notes !== undefined) recipe.notes = notes;

  const prepMinutes = finiteNumber(raw.prepMinutes);
  if (prepMinutes !== undefined && prepMinutes >= 0) recipe.prepMinutes = prepMinutes;

  const cookMinutes = finiteNumber(raw.cookMinutes);
  if (cookMinutes !== undefined && cookMinutes >= 0) recipe.cookMinutes = cookMinutes;

  const lang = normalizeLang(raw.lang);
  if (lang !== undefined) recipe.lang = lang;

  return recipe;
}

/**
 * Source text (pasted, or from `extractRecipeSource`) → outcome.
 * Extraction is the one Gemini call and stays faithful to the source.
 * `translateTo`, when set, may add a translation; it never changes that call.
 */
export async function importFromSource(
  source: string,
  deps: RecipeImportDeps,
  translateTo?: string,
): Promise<ImportOutcome> {
  if (source.trim() === '') {
    return { kind: 'empty_source' };
  }

  const result = await deps.ai.models.generateContent({
    model: deps.model,
    contents:
      'Extract the recipe from the source material below and save it. ' +
      'Convert fractions to decimals for quantities. Keep step texts ' +
      'faithful to the original but trim fluff. If the source contains ' +
      'no recipe, save a recipe with the title "NOT_A_RECIPE".\n\n' +
      `Source material:\n${source}`,
    config: { ...RECIPE_OUTPUT_CONFIG },
  });

  return finishIfExtracted(outcomeFromModelText(result.text), translateTo, deps);
}

function imageImportPrompt(extraText: string): string {
  const prompt = [
    'The photos are the pages of one recipe, often handwritten. Extract the recipe and save it.',
    'Read the pages in the order given: the first photo is page 1.',
    'Transcribe what is written. Skip anything that is crossed out.',
    "If you are unsure how a word reads, write your best reading followed by (?). If you are unsure of an amount, keep your best reading as the quantity and add (?) to that ingredient's note.",
    'If you cannot tell whether an amount is a tablespoon or a teaspoon (for example a T that could be a t), use your best reading and say so in notes.',
    'Never invent quantities, ingredients, or steps that are not written. If an amount is missing or unreadable, leave the quantity out.',
    'Convert fractions to decimals for quantities.',
    'If no title is written, use a short plain name for the dish. Give a description or prep and cook times only if they are written. If servings are not written, use 1.',
    'If the photos contain no recipe, save a recipe with the title "NOT_A_RECIPE".',
  ].join('\n');
  const notes = extraText.trim();
  if (notes === '') return prompt;
  return (
    `${prompt}\n\nNotes from the person importing these photos (context only; the photos are the source):\n` +
    notes.slice(0, MAX_SOURCE_CHARS)
  );
}

/**
 * Photos of one recipe, in page order, plus optional notes → outcome.
 * The one Gemini call extracts. `translateTo`, when set, may add a translation
 * and never changes that call.
 */
export async function importFromImages(
  images: readonly ImportImage[],
  extraText: string,
  deps: RecipeImportDeps,
  translateTo?: string,
): Promise<ImportOutcome> {
  if (images.length === 0) {
    return { kind: 'empty_source' };
  }

  const result = await deps.ai.models.generateContent({
    model: deps.model,
    contents: [
      {
        role: 'user',
        parts: [
          ...images.map((image) => ({
            inlineData: { mimeType: image.mediaType, data: image.base64 },
          })),
          { text: imageImportPrompt(extraText) },
        ],
      },
    ],
    config: {
      ...RECIPE_OUTPUT_CONFIG,
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
    },
  });

  return finishIfExtracted(outcomeFromModelText(result.text), translateTo, deps);
}

function outcomeFromModelText(text: string | undefined): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    return { kind: 'parse_error' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'parse_error' };
  }
  if ((parsed as { title?: unknown }).title === 'NOT_A_RECIPE') {
    return { kind: 'not_a_recipe' };
  }
  const recipe = normalizeImportedRecipe(parsed);
  if (recipe === null) {
    return { kind: 'unusable' };
  }
  return { kind: 'ok', recipe };
}

function finishIfExtracted(
  outcome: ImportOutcome,
  translateTo: string | undefined,
  deps: RecipeImportDeps,
): Promise<ImportOutcome> {
  if (outcome.kind !== 'ok') return Promise.resolve(outcome);
  return finishImport(outcome.recipe, translateTo, deps);
}

/** Page HTML → outcome: `extractRecipeSource` then `importFromSource`. */
export function importFromHtml(
  html: string,
  deps: RecipeImportDeps,
  translateTo?: string,
): Promise<ImportOutcome> {
  return importFromSource(extractRecipeSource(html), deps, translateTo);
}

/**
 * The only environment read in this module. Call it per request, not at module scope.
 * The translator reads env when it is called, the same way extraction reads the key here.
 */
export function recipeImportDepsFromEnv(): RecipeImportDeps {
  return {
    ai: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
    // `??` is wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is not nullish.
    model: process.env.CHAT_MODEL || DEFAULT_MODEL,
    translator: translateWithEnv,
  };
}

/** Missing key and provider errors are translation failures, not thrown import errors. */
async function translateWithEnv(input: TranslateInput): Promise<TranslateOutcome> {
  const built = geminiTranslateDepsFromEnv();
  if (!built.ok) {
    return { ok: false, code: TRANSLATE_FAILED };
  }
  try {
    return await translateSegments(input, built.deps);
  } catch {
    return { ok: false, code: TRANSLATE_FAILED };
  }
}

type TranslationAttempt =
  | { kind: 'failed' }
  | { kind: 'ok'; detectedLang: string | null; recipe: ImportedRecipe };

async function translateRecipe(
  recipe: ImportedRecipe,
  translateTo: string,
  translator: RecipeTranslator,
  sourceLang: string | undefined,
): Promise<TranslationAttempt> {
  const segments = recipeSegments(recipe);
  if (translationExceedsCaps(segments)) {
    return { kind: 'failed' };
  }
  const input: TranslateInput = { segments, target: translateTo };
  if (sourceLang !== undefined) {
    input.sourceLang = sourceLang;
  }
  let outcome: TranslateOutcome;
  try {
    outcome = await translator(input);
  } catch {
    return { kind: 'failed' };
  }
  if (!outcome.ok) {
    return { kind: 'failed' };
  }
  const validated = validateTranslatedSegments(
    segments.map((segment) => segment.id),
    outcome.segments,
  );
  if (!validated.ok) {
    return { kind: 'failed' };
  }
  const applied = applyTranslation(recipe, validated.segments);
  return {
    kind: 'ok',
    detectedLang: normalizeLang(outcome.detectedLang) ?? null,
    recipe: { ...applied, lang: translateTo },
  };
}

/**
 * `translateTo` unset: the extraction alone.
 * Same language: skip the translator.
 * Different: translate with the extracted source language.
 * Missing or ambiguous (`sameLanguage` is `unknown`, including bare `zh`
 * against `zh-Hans`): translate with no source language. A detected language
 * that matches the target discards the translation and labels the original.
 * Otherwise the original is labelled with the detection and the translation
 * is returned. Provider failure, caps, and bad segments set `translation`
 * to `{ kind: 'failed' }` and still return the original.
 */
async function finishImport(
  recipe: ImportedRecipe,
  translateTo: string | undefined,
  deps: RecipeImportDeps,
): Promise<ImportOutcome> {
  if (translateTo === undefined) {
    return { kind: 'ok', recipe };
  }
  const comparison = sameLanguage(recipe.lang, translateTo);
  if (comparison === 'same') {
    return { kind: 'ok', recipe };
  }
  const knownSource = comparison === 'different';
  const attempt = await translateRecipe(
    recipe,
    translateTo,
    deps.translator,
    knownSource ? recipe.lang : undefined,
  );
  if (attempt.kind === 'failed') {
    return { kind: 'ok', recipe, translation: { kind: 'failed' } };
  }
  if (
    !knownSource &&
    attempt.detectedLang !== null &&
    sameLanguage(attempt.detectedLang, translateTo) === 'same'
  ) {
    return { kind: 'ok', recipe: { ...recipe, lang: attempt.detectedLang } };
  }
  const original =
    !knownSource && attempt.detectedLang !== null
      ? { ...recipe, lang: attempt.detectedLang }
      : recipe;
  return {
    kind: 'ok',
    recipe: original,
    translation: { kind: 'ok', lang: translateTo, recipe: attempt.recipe },
  };
}
