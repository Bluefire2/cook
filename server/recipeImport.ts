/**
 * Recipe import: page HTML or pasted text in, a saveable recipe draft out.
 *
 * The one pipeline behind `POST /api/import` (`server/importRoute.ts`) and
 * `POST /api/extension/import` (`server/extensionImport.ts`). Nothing here
 * knows about HTTP: routes map `ImportOutcome` / `PageFetchOutcome` to
 * statuses and copy. The
 * Gemini client and model are passed in; `recipeImportDepsFromEnv` is the only
 * place that reads the environment.
 */
import { GoogleGenAI, Type, type Schema } from '@google/genai';

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
}

export interface RecipeImportDeps {
  /** Only `models.generateContent` is used; fakes implement exactly this. */
  ai: { models: Pick<GoogleGenAI['models'], 'generateContent'> };
  model: string;
}

export type ImportOutcome =
  | { kind: 'ok'; recipe: ImportedRecipe }
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
// `update_recipe`. Keep the two in sync until chat gets the same treatment.
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
  },
  required: ['title', 'servings', 'ingredientSections', 'steps', 'tags'],
};

interface HtmlTag {
  lower: string;
  start: number;
  after: number;
  closing: boolean;
  selfClosing: boolean;
  roleMain: boolean;
}

/**
 * A `<` starts a tag only when a name follows (`<article`, `</div>`). Bare
 * comparisons in the copy (`heat to <350°F, don't`) are not tags: treating the
 * apostrophe as an attribute quote would swallow every tag after it.
 */
function isTagStart(html: string, lt: number): boolean {
  let i = lt + 1;
  if (html[i] === '/') i += 1;
  while (html[i] === ' ' || html[i] === '\n' || html[i] === '\t' || html[i] === '\r') i += 1;
  const c = html[i];
  return c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
}

/** Index of the next `>` that is not inside a quoted attribute. */
function tagEnd(html: string, openAt: number): number {
  let quote: string | null = null;
  for (let i = openAt + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
  }
  return -1;
}

/**
 * Tags outside comments, scripts, and styles. Balancing uses these so a nested
 * `<div>` or `<article>` does not end the region at the first closing tag.
 */
function scanTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (!isTagStart(html, lt)) {
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end === -1) break;
    const raw = html.slice(lt + 1, end);
    const closing = raw.startsWith('/');
    const body = closing ? raw.slice(1) : raw;
    const nameMatch = /^([A-Za-z][\w:-]*)/.exec(body.trimStart());
    if (!nameMatch) {
      i = end + 1;
      continue;
    }
    const name = nameMatch[1];
    const selfClosing = /\/\s*$/.test(raw) && !closing;
    const roleMain = /\brole\s*=\s*(?:["']main["']|main\b)/i.test(raw);
    tags.push({
      lower: name.toLowerCase(),
      start: lt,
      after: end + 1,
      closing,
      selfClosing,
      roleMain,
    });
    i = end + 1;
    if (!closing && !selfClosing && (name.toLowerCase() === 'script' || name.toLowerCase() === 'style')) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'i');
      const found = closeRe.exec(html.slice(i));
      i = found ? i + found.index + found[0].length : html.length;
    }
  }
  return tags;
}

function balancedElement(html: string, tags: HtmlTag[], openAt: number): string | null {
  const open = tags[openAt];
  if (open.closing || open.selfClosing) return null;
  let depth = 1;
  for (let i = openAt + 1; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.lower !== open.lower || tag.selfClosing) continue;
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return html.slice(open.start, tag.after);
    } else {
      depth += 1;
    }
  }
  return null;
}

function regionTextLength(region: string): number {
  return region.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

function longestRegion(
  html: string,
  tags: HtmlTag[],
  include: (tag: HtmlTag) => boolean,
): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (let i = 0; i < tags.length; i++) {
    if (!include(tags[i])) continue;
    const region = balancedElement(html, tags, i);
    if (region === null) continue;
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
 * would eat the 60k text cap. The longest balanced `<article>` wins, so a
 * header teaser or a nested related-story card does not replace the story.
 * A short article beside a larger `<main>` / `role="main"` yields to that
 * region. Recipe JSON-LD is preferred when it actually has ingredients or steps.
 */
function primaryRegion(html: string): string {
  const tags = scanTags(html);
  const article = longestRegion(html, tags, (tag) => tag.lower === 'article');
  const main = longestRegion(
    html,
    tags,
    (tag) => tag.lower === 'main' || tag.roleMain,
  );
  if (article && main) {
    if (regionTextLength(article) * 2 >= regionTextLength(main)) return article;
    return main;
  }
  return article ?? main ?? html;
}

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
 * Prefers the schema.org/Recipe JSON-LD block most recipe sites embed
 * (compact and unambiguous); falls back to the page's stripped text,
 * preferring `<article>` / `<main>` so a news-article recipe is not lost
 * behind nav chrome. An empty Recipe block does not count.
 */
export function extractRecipeSource(html: string): string {
  const ldBlocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of ldBlocks) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : ((parsed as { '@graph'?: unknown[] })['@graph'] ?? [parsed]);
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const type = (node as { '@type'?: string | string[] })['@type'];
        const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
        if (isRecipe && recipeJsonLdHasBody(node)) {
          return JSON.stringify(node).slice(0, MAX_SOURCE_CHARS);
        }
      }
    } catch {
      // Malformed JSON-LD — keep looking.
    }
  }

  return stripToText(primaryRegion(html));
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

  return recipe;
}

/** Source text (pasted, or from `extractRecipeSource`) → outcome. The one Gemini call. */
export async function importFromSource(
  source: string,
  deps: RecipeImportDeps,
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
    config: {
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: RECIPE_SCHEMA,
    },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text ?? '');
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

/** Page HTML → outcome: `extractRecipeSource` then `importFromSource`. */
export function importFromHtml(html: string, deps: RecipeImportDeps): Promise<ImportOutcome> {
  return importFromSource(extractRecipeSource(html), deps);
}

/** The only environment read in this module. Call it per request, not at module scope. */
export function recipeImportDepsFromEnv(): RecipeImportDeps {
  return {
    ai: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
    // `??` is wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is not nullish.
    model: process.env.CHAT_MODEL || DEFAULT_MODEL,
  };
}
