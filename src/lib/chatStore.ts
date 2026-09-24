import { useMemo, useSyncExternalStore } from 'react';
import {
  clearChatLocal,
  getSnapshot,
  listChat,
  subscribe,
  upsertChat,
  getPendingBlob,
  markPhotoRemote,
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import type { ChatMessage } from './types';

async function uploadMessagePhotos(message: ChatMessage): Promise<void> {
  for (const photoId of message.photoIds ?? []) {
    const blob = getPendingBlob(photoId);
    if (!blob) {
      continue;
    }
    const result = await postPhoto(photoId, message.recipeId, message.createdAt, blob);
    if (result !== 'ok') {
      throw new Error(
        result === 'signedOut'
          ? 'Please sign in again — your session expired.'
          : "Couldn't save the photo.",
      );
    }
    markPhotoRemote(photoId);
  }
}

export const chatStore = {
  listForRecipe(recipeId: string): ChatMessage[] {
    return listChat(recipeId);
  },

  async append(
    data: Omit<ChatMessage, 'id' | 'createdAt'>,
  ): Promise<ChatMessage> {
    const previous = listChat(data.recipeId);
    const message: ChatMessage = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    upsertChat(message);
    try {
      await uploadMessagePhotos(message);
      const result = await pushOps([{ kind: 'chat.put', payload: message }]);
      if (result !== 'ok') {
        throw new Error(
          result === 'signedOut'
            ? 'Please sign in again — your session expired.'
            : "Couldn't save the message.",
        );
      }
    } catch (err) {
      clearChatLocal(data.recipeId);
      for (const existing of previous) {
        upsertChat(existing);
      }
      throw err;
    }
    return message;
  },

  async clearForRecipe(recipeId: string): Promise<void> {
    const previous = listChat(recipeId);
    const at = Date.now();
    clearChatLocal(recipeId);
    const result = await pushOps([
      { kind: 'chat.clearForRecipe', payload: { recipeId, at } },
    ]);
    if (result !== 'ok') {
      for (const message of previous) {
        upsertChat(message);
      }
      throw new Error(
        result === 'signedOut'
          ? 'Please sign in again — your session expired.'
          : "Couldn't clear the chat.",
      );
    }
  },
};

/** Reactive chat thread for a recipe, oldest first. `undefined` while loading. */
export function useChatMessages(recipeId: string): ChatMessage[] | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    if (!snap.loaded) {
      return undefined;
    }
    return listChat(recipeId);
  }, [snap, recipeId]);
}
