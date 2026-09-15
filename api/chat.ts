import { GoogleGenAI, Type, type Content, type Part, type Schema } from '@google/genai';

// NOTE: Duplicated in api/import.ts. Vercel's function runtime transpiles
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
const MODEL = process.env.CHAT_MODEL || 'gemini-3.7-flash';

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

function toGeminiContents(messages: ChatRequestMessage[]): Content[] {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (m.role === 'user' && m.images && m.images.length > 0) {
      const parts: Part[] = m.images.map((img) => ({
        inlineData: { mimeType: img.mediaType, data: img.base64 },
      }));
      if (m.content) parts.push({ text: m.content });
      return { role, parts };
    }
    return { role, parts: [{ text: m.content }] };
  });
}

export async function POST(req: Request): Promise<Response> {
  // A set-but-blank server password would match the '' that settings.getPassword() returns
  // for a client that never saved one, turning the deployment into an open proxy.
  if (!process.env.APP_PASSWORD || req.headers.get('x-app-password') !== process.env.APP_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = (await req.json()) as ChatRequestBody;
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const abort = new AbortController();

  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: toGeminiContents(body.messages),
    config: {
      abortSignal: abort.signal,
      systemInstruction: systemPrompt(body.recipe, body.cookingState),
      maxOutputTokens: 4096,
      tools: [
        {
          functionDeclarations: [
            {
              name: 'update_recipe',
              description:
                'Propose a modified version of the recipe the user is viewing. ' +
                'Pass the complete updated recipe.',
              parameters: RECIPE_SCHEMA,
            },
          ],
        },
      ],
    },
  });

  // Plain text streams as-is, then a separator (0x1E), then any proposal JSON, then a
  // final separator that marks a clean end. Fewer than three parts means the stream was cut off.
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          let proposalArgs: Record<string, unknown> | undefined;
          for await (const chunk of stream) {
            if (chunk.text) controller.enqueue(encoder.encode(chunk.text));
            const update = chunk.functionCalls?.find(
              (call) => call.name === 'update_recipe' && call.args,
            );
            if (update?.args) proposalArgs = update.args;
          }
          const proposal = proposalArgs ? JSON.stringify(proposalArgs) : '';
          controller.enqueue(encoder.encode(`\x1E${proposal}\x1E`));
          controller.close();
        } catch (err) {
          if (abort.signal.aborted) {
            controller.close();
            return;
          }
          controller.error(err);
        }
      })();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
