import { settings } from './settings';
import type { EncodedImage } from './image';
import type { Recipe } from './types';

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

/**
 * Streams an assistant reply. Calls `onDelta` with the text so far on every
 * chunk and resolves with the complete reply.
 */
export async function streamChatReply(params: {
  messages: OutgoingMessage[];
  recipe: Recipe;
  cookingState?: CookingState;
  onDelta: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
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
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    params.onDelta(text);
  }
  return text;
}
