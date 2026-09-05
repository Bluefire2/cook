import { settings } from './settings';
import type { EncodedImage } from './image';
import { normalizeRecipeDraft } from './recipeShape';
import type { Recipe, RecipeDraft } from './types';

export interface OutgoingMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: EncodedImage[];
}

export interface CookingState {
  servings: number;
  currentStep: number;
  checkedIngredients: string[];
}

export interface ChatReply {
  text: string;
  /** Present when the assistant proposed a recipe modification. */
  proposedRecipe?: RecipeDraft;
  /** The stream ended without its terminator, so the reply is cut off. */
  truncated: boolean;
}

/**
 * Streams an assistant reply. Calls `onDelta` with the text so far on every
 * chunk and resolves with the complete reply. A proposed recipe update, if
 * any, arrives after an ASCII Record Separator (0x1E) as JSON.
 */
export async function streamChatReply(params: {
  messages: OutgoingMessage[];
  recipe: Recipe;
  cookingState?: CookingState;
  onDelta: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<ChatReply> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-password': settings.getPassword(),
    },
    body: JSON.stringify({
      messages: params.messages,
      recipe: params.recipe,
      cookingState: params.cookingState,
    }),
    signal: params.signal,
  });

  if (response.status === 401) {
    throw new Error('Wrong or missing app password — set it in Settings.');
  }
  if (!response.ok || !response.body) {
    throw new Error(`Assistant request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    params.onDelta(raw.split('\x1E')[0]);
  }

  // A function killed by the platform looks exactly like a clean `done` to the reader —
  // only the trailing separator distinguishes a complete reply from a cut-off one.
  const parts = raw.split('\x1E');
  const complete = parts.length >= 3;
  const text = parts[0];
  let proposedRecipe: RecipeDraft | undefined;
  if (complete && parts[1]) {
    try {
      proposedRecipe = normalizeRecipeDraft(JSON.parse(parts[1]));
    } catch {
      // Truncated/malformed proposal — keep the text reply.
    }
  }
  return { text, proposedRecipe, truncated: !complete };
}
