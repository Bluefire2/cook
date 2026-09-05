import Anthropic from '@anthropic-ai/sdk';

// NOTE: Duplicated in api/import.ts. Vercel's function runtime transpiles
// each api/ entrypoint in isolation and cannot import sibling helper files,
// so the schema must live inline. Keep both copies in sync.
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

export interface ChatRequestImage {
  /** e.g. "image/jpeg" */
  mediaType: string;
  /** Raw base64, no data-URL prefix. */
  base64: string;
}

export interface ChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ChatRequestImage[];
}

export interface ChatRequestBody {
  messages: ChatRequestMessage[];
  /** The full recipe JSON the user is currently viewing. */
  recipe: unknown;
  /** Where the user is in the cook: current step, checked ingredients, servings. */
  cookingState?: unknown;
}

// `??` is wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is not nullish.
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';

// A turn that triggers update_recipe streams a text reply and then the complete recipe JSON —
// the slowest response this app produces, so Vercel's 10s default can kill it.
export const maxDuration = 60;

function systemPrompt(recipe: unknown, cookingState: unknown): string {
  return [
    'You are a cooking assistant embedded in a personal recipe app. The user',
    'is viewing (and possibly mid-way through cooking) the recipe below, so',
    'they may have messy hands and limited patience: answer concisely and',
    'practically, like a calm chef talking to a home cook. Refer to steps by',
    'their number. If the user sends a photo, assess it honestly against',
    'where they are in the recipe. Reply in plain text only — no markdown',
    'syntax like ** or #, since the app renders your reply verbatim. Use',
    'simple dashes for lists.',
    '',
    'When the user asks you to modify the recipe (substitutions, scaling',
    'techniques, dietary changes, adding/removing components), call the',
    'update_recipe tool with the COMPLETE updated recipe — every field, not',
    'just the changed parts. Briefly say what you changed in your text reply.',
    'The app shows the user a diff and lets them apply it, so do not ask for',
    'permission first. For pure questions, answer without the tool.',
    '',
    'Current recipe (JSON):',
    JSON.stringify(recipe),
    '',
    cookingState ? `Cooking state (JSON): ${JSON.stringify(cookingState)}` : '',
  ].join('\n');
}

function toAnthropicMessages(
  messages: ChatRequestMessage[],
): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role === 'user' && m.images && m.images.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = m.images.map((img) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType as 'image/jpeg',
          data: img.base64,
        },
      }));
      if (m.content) blocks.push({ type: 'text', text: m.content });
      return { role: 'user', content: blocks };
    }
    return { role: m.role, content: m.content };
  });
}

export async function POST(req: Request): Promise<Response> {
  // A set-but-blank server password would match the '' that settings.getPassword() returns
  // for a client that never saved one, turning the deployment into an open proxy.
  if (!process.env.APP_PASSWORD || req.headers.get('x-app-password') !== process.env.APP_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = (await req.json()) as ChatRequestBody;
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt(body.recipe, body.cookingState),
    messages: toAnthropicMessages(body.messages),
    tools: [
      {
        name: 'update_recipe',
        description:
          'Propose a modified version of the recipe the user is viewing. ' +
          'Pass the complete updated recipe.',
        input_schema: RECIPE_SCHEMA,
      },
    ],
  });

  // Plain text streams as-is, then a separator (0x1E), then any proposal JSON, then a
  // final separator that marks a clean end. Fewer than three parts means the stream was cut off.
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('text', (delta) => {
        controller.enqueue(encoder.encode(delta));
      });
      stream.on('end', () => {
        void (async () => {
          try {
            const final = await stream.finalMessage();
            const toolUse = final.content.find(
              (b) => b.type === 'tool_use' && b.name === 'update_recipe',
            );
            const proposal =
              toolUse && toolUse.type === 'tool_use'
                ? JSON.stringify(toolUse.input)
                : '';
            controller.enqueue(encoder.encode(`\x1E${proposal}\x1E`));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        })();
      });
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
