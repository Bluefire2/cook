import { useMemo, useSyncExternalStore } from 'react';
import { t } from '../i18n';
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
import { SessionExpiredError } from './sessionExpired';
import type { ChatMessage } from './types';

async function uploadMessagePhotos(message: ChatMessage): Promise<void> {
  for (const photoId of message.photoIds ?? []) {
    const blob = getPendingBlob(photoId);
    if (!blob) {
      continue;
    }
    const result = await postPhoto(photoId, message.recipeId, message.createdAt, blob);
    if (result !== 'ok') {
      throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.photoSave'));
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
        throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.messageSave'));
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The 401 cleared the library already; write nothing back into it.
        throw err;
      }
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
    if (result === 'signedOut') {
      // The 401 cleared the library already; write nothing back into it.
      throw new SessionExpiredError();
    }
    if (result !== 'ok') {
      for (const message of previous) {
        upsertChat(message);
      }
      throw new Error(t('error.chatClear'));
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
