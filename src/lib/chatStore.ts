import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { enqueue } from './outbox';
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
    await db.transaction('rw', [db.chatMessages, db.photos, db.outbox], async (tx) => {
      for (const photoId of message.photoIds ?? []) {
        const photo = await db.photos.get(photoId);
        await enqueue(tx, {
          kind: 'photo.put',
          payload: {
            id: photoId,
            recipeId: message.recipeId,
            updatedAt: photo?.createdAt ?? Date.now(),
          },
        });
      }
      await db.chatMessages.add(message);
      await enqueue(tx, { kind: 'chat.put', payload: message });
    });
    return message;
  },

  async clearForRecipe(recipeId: string): Promise<void> {
    const at = Date.now();
    await db.transaction('rw', [db.chatMessages, db.photos, db.outbox], async (tx) => {
      const messages = await db.chatMessages
        .where('recipeId')
        .equals(recipeId)
        .toArray();
      await db.chatMessages.where('recipeId').equals(recipeId).delete();
      const photoIds = messages.flatMap((m) => m.photoIds ?? []);
      await db.photos.bulkDelete(photoIds);
      await enqueue(tx, {
        kind: 'chat.clearForRecipe',
        payload: { recipeId, at },
      });
      for (const id of photoIds) {
        await enqueue(tx, {
          kind: 'photo.delete',
          payload: { id, updatedAt: at },
        });
      }
    });
  },
};

/** Reactive chat thread for a recipe, oldest first. `undefined` while loading. */
export function useChatMessages(recipeId: string): ChatMessage[] | undefined {
  return useLiveQuery(() => chatStore.listForRecipe(recipeId), [recipeId]);
}
