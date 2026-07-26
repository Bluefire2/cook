import Anthropic from '@anthropic-ai/sdk';

interface ImportRequestBody {
  /** URL of a recipe page to fetch and extract. */
  url?: string;
  /** Raw recipe text pasted by the user (used when no url is given). */
  text?: string;
}

const MODEL = process.env.CHAT_MODEL ?? 'claude-sonnet-4-5';

/** Matches the app's Recipe type (src/lib/types.ts), minus id/timestamps. */
const RECIPE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string', description: 'One or two sentences.' },
    servings: { type: 'number' },
    prepMinutes: { type: 'number' },
    cookMinutes: { type: 'number' },
    ingredientSections: {
      type: 'array',
      description:
        'Use a single unnamed section unless the recipe clearly has component groups like "Sauce" and "Dough".',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                quantity: { type: 'number', description: 'e.g. 0.5 for ½' },
                unit: { type: 'string', description: 'e.g. g, tbsp, cup' },
                item: { type: 'string', description: 'The ingredient itself' },
                note: { type: 'string', description: 'e.g. "thinly sliced"' },
              },
              required: ['item'],
            },
          },
        },
        required: ['items'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 short lowercase tags like "pasta", "weeknight".',
    },
    notes: { type: 'string', description: 'Tips or variations worth keeping.' },
  },
  required: ['title', 'servings', 'ingredientSections', 'steps', 'tags'],
};

/**
 * Prefers the schema.org/Recipe JSON-LD block most recipe sites embed
 * (compact and unambiguous); falls back to the page's stripped text.
 */
function extractRecipeSource(html: string): string {
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
          return JSON.stringify(node);
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
    .slice(0, 60000);
}

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get('x-app-password') !== process.env.APP_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = (await req.json()) as ImportRequestBody;

  let source = body.text?.trim() ?? '';
  if (body.url) {
    let page: Response;
    try {
      page = await fetch(body.url, {
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

  const anthropic = new Anthropic();
  const result = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [
      {
        name: 'save_recipe',
        description:
          'Save the recipe extracted from the source material in structured form.',
        input_schema: RECIPE_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'save_recipe' },
    messages: [
      {
        role: 'user',
        content:
          'Extract the recipe from the source material below and save it. ' +
          'Convert fractions to decimals for quantities. Keep step texts ' +
          'faithful to the original but trim fluff. If the source contains ' +
          'no recipe, save a recipe with the title "NOT_A_RECIPE".\n\n' +
          `Source material:\n${source}`,
      },
    ],
  });

  const toolUse = result.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    return Response.json(
      { error: 'Extraction failed — no structured result.' },
      { status: 502 },
    );
  }

  const recipe = toolUse.input as { title?: string };
  if (recipe.title === 'NOT_A_RECIPE') {
    return Response.json(
      { error: "Couldn't find a recipe in that content." },
      { status: 422 },
    );
  }

  return Response.json({ recipe: { ...recipe, sourceUrl: body.url } });
}
