import { createHmac, timingSafeEqual } from 'node:crypto';
import { GoogleGenAI, Type, type Schema } from '@google/genai';

// NOTE: Duplicated in api/chat.ts and server/session.ts + server/allowlist.ts.
// This inline copy is the Vercel gate and must stay in sync with those files.
// On Cloud Run it is bypassed by an explicit authorizedSub argument after
// requireMember passed in scripts/server.ts; server/membership.ts is authoritative.

const SESSION_COOKIE_NAME = 'sous_session';

function parseAllowedEmails(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email !== '') {
      out.add(email);
    }
  }
  return out;
}

function isEmailAllowed(email: string, raw: string): boolean {
  if (raw.trim() === '') {
    return false;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  return parseAllowedEmails(raw).has(normalized);
}

function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key !== SESSION_COOKIE_NAME) {
      continue;
    }
    return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionSub(req: Request): string | null {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret.trim() === '') {
    return null;
  }
  const token = readSessionCookie(req);
  if (token === null) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot === -1 || token.indexOf('.', dot + 1) !== -1) {
    return null;
  }
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (sigPart === '' || /[^A-Za-z0-9_-]/.test(sigPart)) {
    return null;
  }
  const actual = Buffer.from(sigPart, 'base64url');
  if (actual.toString('base64url') !== sigPart) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  if (expected.length !== actual.length) {
    return null;
  }
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }
  if (payloadPart === '' || /[^A-Za-z0-9_-]/.test(payloadPart)) {
    return null;
  }
  const payloadBuf = Buffer.from(payloadPart, 'base64url');
  if (payloadBuf.toString('base64url') !== payloadPart) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    sub?: unknown;
    email?: unknown;
    exp?: unknown;
  };
  if (row.v !== 1) {
    return null;
  }
  if (typeof row.sub !== 'string' || row.sub === '') {
    return null;
  }
  if (typeof row.email !== 'string') {
    return null;
  }
  if (typeof row.exp !== 'number' || row.exp <= Date.now()) {
    return null;
  }
  if (!isEmailAllowed(row.email, process.env.ALLOWED_EMAILS ?? '')) {
    return null;
  }
  return row.sub;
}

// NOTE: Duplicated in api/chat.ts. Vercel's function runtime transpiles
// each api/ entrypoint in isolation and cannot import sibling helper files,
// so the schema must live inline. Keep both copies in sync.
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

interface ImportRequestBody {
  /** URL of a recipe page to fetch and extract. */
  url?: string;
  /** Raw recipe text pasted by the user (used when no url is given). */
  text?: string;
}

// `??` is wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is not nullish.
const MODEL = process.env.CHAT_MODEL || 'gemini-3.7-flash';

const MAX_SOURCE_CHARS = 60000;

// This handler awaits a complete non-streaming extraction, which regularly
// outlasts Vercel's 10s default and would surface as a timeout, not an error.
export const maxDuration = 60;

/**
 * Prefers the schema.org/Recipe JSON-LD block most recipe sites embed
 * (compact and unambiguous); falls back to the page's stripped text.
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
        const type = (node as { '@type'?: string | string[] })['@type'];
        if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) {
          return JSON.stringify(node).slice(0, MAX_SOURCE_CHARS);
        }
      }
    } catch {
      // Malformed JSON-LD — keep looking.
    }
  }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_SOURCE_CHARS);
}

export type PageFetchResult =
  | { ok: true; html: string }
  | { ok: false; status: number; error: string };

/**
 * Also used by `server/extensionImport.ts`, which needs the same fetch and the
 * same user-facing wording. Exported rather than duplicated: the no-sibling-
 * imports rule is about `api/` entrypoints importing each other under Vercel's
 * isolated transpile, and nothing here imports a sibling.
 */
export async function fetchPageHtml(rawUrl: string): Promise<PageFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, status: 422, error: 'That does not look like a web address.' };
  }
  // Scheme check only (matches RecipeView's http/https allowlist); does not block private or link-local destinations.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: 422, error: 'Only http and https URLs are supported.' };
  }

  let page: Response;
  try {
    page = await fetch(parsed.href, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
  } catch {
    return { ok: false, status: 422, error: 'Could not reach that URL.' };
  }
  if (!page.ok) {
    return {
      ok: false,
      status: 422,
      error: `The site refused the request (${page.status}). Try pasting the recipe text instead.`,
    };
  }
  return { ok: true, html: await page.text() };
}

export type GenerateRecipeResult =
  | { status: 'ok'; recipe: Record<string, unknown> }
  | { status: 'not_a_recipe' }
  | { status: 'parse_error' };

/**
 * Structured Gemini extraction used by POST /api/import (text and URL paths).
 * Kept in this file because Vercel cannot import api/ siblings.
 */
export async function generateRecipeFromSource(
  source: string,
): Promise<GenerateRecipeResult> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const result = await ai.models.generateContent({
    model: MODEL,
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

  let recipe: { title?: string };
  try {
    const parsed: unknown = JSON.parse(result.text ?? '');
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not an object');
    }
    recipe = parsed as { title?: string };
  } catch {
    return { status: 'parse_error' };
  }
  if (recipe.title === 'NOT_A_RECIPE') {
    return { status: 'not_a_recipe' };
  }
  return { status: 'ok', recipe: recipe as Record<string, unknown> };
}

export type ExtractionResult =
  | { ok: true; recipe: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/** The Gemini half of an extension import: source material in, recipe fields out. */
export async function extractRecipeDraft(source: string): Promise<ExtractionResult> {
  const extracted = await generateRecipeFromSource(source);
  if (extracted.status === 'parse_error') {
    return { ok: false, status: 502, error: 'Extraction failed — no structured result.' };
  }
  if (extracted.status === 'not_a_recipe') {
    return { ok: false, status: 422, error: "Couldn't find a recipe in that content." };
  }
  return { ok: true, recipe: extracted.recipe };
}

export async function POST(req: Request, ctx?: { authorizedSub?: string }): Promise<Response> {
  const authorized =
    typeof ctx?.authorizedSub === 'string' && ctx.authorizedSub !== ''
      ? ctx.authorizedSub
      : sessionSub(req);
  if (authorized === null) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = (await req.json()) as ImportRequestBody;

  let source = body.text?.trim() ?? '';
  if (body.url) {
    const page = await fetchPageHtml(body.url);
    if (!page.ok) {
      return Response.json({ error: page.error }, { status: page.status });
    }
    source = extractRecipeSource(page.html);
  }

  if (source === '') {
    return Response.json(
      { error: 'Provide a URL or recipe text.' },
      { status: 400 },
    );
  }

  const extracted = await generateRecipeFromSource(source);
  if (extracted.status === 'parse_error') {
    return Response.json(
      { error: 'Extraction failed — no structured result.' },
      { status: 502 },
    );
  }
  if (extracted.status === 'not_a_recipe') {
    return Response.json(
      { error: "Couldn't find a recipe in that content." },
      { status: 422 },
    );
  }

  return Response.json({ recipe: { ...extracted.recipe, sourceUrl: body.url } });
}
