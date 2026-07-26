import { settings } from './settings';
import type { EncodedImage } from './image';
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

  const [text, proposalJson] = raw.split('\x1E');
  let proposedRecipe: RecipeDraft | undefined;
  if (proposalJson) {
    try {
      proposedRecipe = JSON.parse(proposalJson) as RecipeDraft;
    } catch {
      // Truncated/malformed proposal — keep the text reply.
    }
  }
  return { text, proposedRecipe };
}
