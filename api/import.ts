import { GoogleGenAI, Type, type Schema } from '@google/genai';

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

export async function POST(req: Request): Promise<Response> {
  // A set-but-blank server password would match the '' that settings.getPassword() returns
  // for a client that never saved one, turning the deployment into an open proxy.
  if (!process.env.APP_PASSWORD || req.headers.get('x-app-password') !== process.env.APP_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = (await req.json()) as ImportRequestBody;

  let source = body.text?.trim() ?? '';
  if (body.url) {
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      return Response.json(
        { error: 'That does not look like a web address.' },
        { status: 422 },
      );
    }
    // Scheme check only (matches RecipeView's http/https allowlist); does not block private or link-local destinations.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return Response.json(
        { error: 'Only http and https URLs are supported.' },
        { status: 422 },
      );
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
      return Response.json(
        { error: 'Could not reach that URL.' },
        { status: 422 },
      );
    }
    if (!page.ok) {
      return Response.json(
        { error: `The site refused the request (${page.status}). Try pasting the recipe text instead.` },
        { status: 422 },
      );
    }
    source = extractRecipeSource(await page.text());
  }

  if (source === '') {
    return Response.json(
      { error: 'Provide a URL or recipe text.' },
      { status: 400 },
    );
  }

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
    return Response.json(
      { error: 'Extraction failed — no structured result.' },
      { status: 502 },
    );
  }
  if (recipe.title === 'NOT_A_RECIPE') {
    return Response.json(
      { error: "Couldn't find a recipe in that content." },
      { status: 422 },
    );
  }

  return Response.json({ recipe: { ...recipe, sourceUrl: body.url } });
}
