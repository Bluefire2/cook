import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { ChatMessage } from './types';

export const chatStore = {
  listForRecipe(recipeId: string): Promise<ChatMessage[]> {
    return db.chatMessages
      .where('recipeId')
      .equals(recipeId)
      .sortBy('createdAt');
  },

  async append(
    data: Omit<ChatMessage, 'id' | 'createdAt'>,
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    await db.chatMessages.add(message);
    return message;
  },

  async clearForRecipe(recipeId: string): Promise<void> {
    await db.chatMessages.where('recipeId').equals(recipeId).delete();
  },
};

/** Reactive chat thread for a recipe, oldest first. `undefined` while loading. */
export function useChatMessages(recipeId: string): ChatMessage[] | undefined {
  return useLiveQuery(() => chatStore.listForRecipe(recipeId), [recipeId]);
}
