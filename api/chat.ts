import Anthropic from '@anthropic-ai/sdk';
import { RECIPE_SCHEMA } from './_recipeSchema.ts';

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

const MODEL = process.env.CHAT_MODEL ?? 'claude-sonnet-4-5';

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
  if (req.headers.get('x-app-password') !== process.env.APP_PASSWORD) {
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

  // Plain text streams as-is; if the model proposed a recipe update, it is
  // appended after an ASCII Record Separator (0x1E) as a JSON payload.
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
            if (toolUse && toolUse.type === 'tool_use') {
              controller.enqueue(
                encoder.encode('\x1E' + JSON.stringify(toolUse.input)),
              );
            }
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
