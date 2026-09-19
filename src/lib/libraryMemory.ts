import { recipePhotoIds } from './recipePhotos';
import type { ChatMessage, Recipe } from './types';
import type { CookStateRow } from './useCookState';

export type LibrarySnapshot = {
  recipes: ReadonlyMap<string, Recipe>;
  chat: ReadonlyMap<string, ChatMessage>;
  cook: ReadonlyMap<string, CookStateRow>;
  remotePhotoIds: ReadonlySet<string>;
  pendingBlobs: ReadonlyMap<string, Blob>;
  loaded: boolean;
};

const listeners = new Set<() => void>();

function empty(loaded: boolean): LibrarySnapshot {
  return {
    recipes: new Map(),
    chat: new Map(),
    cook: new Map(),
    remotePhotoIds: new Set(),
    pendingBlobs: new Map(),
    loaded,
  };
}

let snapshot: LibrarySnapshot = empty(false);

function emit(next: LibrarySnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function cloneMaps(from: LibrarySnapshot): {
  recipes: Map<string, Recipe>;
  chat: Map<string, ChatMessage>;
  cook: Map<string, CookStateRow>;
  remotePhotoIds: Set<string>;
  pendingBlobs: Map<string, Blob>;
} {
  return {
    recipes: new Map(from.recipes),
    chat: new Map(from.chat),
    cook: new Map(from.cook),
    remotePhotoIds: new Set(from.remotePhotoIds),
    pendingBlobs: new Map(from.pendingBlobs),
  };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): LibrarySnapshot {
  return snapshot;
}

export function markLoaded(): void {
  if (snapshot.loaded) {
    return;
  }
  emit({ ...snapshot, loaded: true });
}

export function clearLibrary(): void {
  emit(empty(true));
}

export function replaceFromPull(next: {
  recipes: Map<string, Recipe>;
  chat: Map<string, ChatMessage>;
  cook: Map<string, CookStateRow>;
  remotePhotoIds: Set<string>;
}): void {
  emit({
    recipes: next.recipes,
    chat: next.chat,
    cook: next.cook,
    remotePhotoIds: next.remotePhotoIds,
    pendingBlobs: snapshot.pendingBlobs,
    loaded: true,
  });
}

export function upsertRecipe(recipe: Recipe): void {
  const next = cloneMaps(snapshot);
  next.recipes.set(recipe.id, recipe);
  emit({ ...snapshot, ...next });
}

export function removeRecipeLocal(id: string): void {
  const next = cloneMaps(snapshot);
  const recipe = next.recipes.get(id);
  next.recipes.delete(id);
  next.cook.delete(id);
  for (const [messageId, message] of next.chat) {
    if (message.recipeId === id) {
      next.chat.delete(messageId);
      for (const photoId of message.photoIds ?? []) {
        next.pendingBlobs.delete(photoId);
        next.remotePhotoIds.delete(photoId);
      }
    }
  }
  for (const photoId of recipe ? recipePhotoIds(recipe) : []) {
    next.pendingBlobs.delete(photoId);
    next.remotePhotoIds.delete(photoId);
  }
  emit({ ...snapshot, ...next });
}

export function upsertChat(message: ChatMessage): void {
  const next = cloneMaps(snapshot);
  next.chat.set(message.id, message);
  emit({ ...snapshot, ...next });
}

export function clearChatLocal(recipeId: string): void {
  const next = cloneMaps(snapshot);
  for (const [messageId, message] of next.chat) {
    if (message.recipeId === recipeId) {
      next.chat.delete(messageId);
      for (const photoId of message.photoIds ?? []) {
        next.pendingBlobs.delete(photoId);
        next.remotePhotoIds.delete(photoId);
      }
    }
  }
  emit({ ...snapshot, ...next });
}

export function upsertCook(row: CookStateRow): void {
  const next = cloneMaps(snapshot);
  next.cook.set(row.recipeId, row);
  emit({ ...snapshot, ...next });
}

export function addPendingBlob(id: string, blob: Blob): void {
  const next = cloneMaps(snapshot);
  next.pendingBlobs.set(id, blob);
  emit({ ...snapshot, ...next });
}

export function dropPendingBlob(id: string): void {
  if (!snapshot.pendingBlobs.has(id)) {
    return;
  }
  const next = cloneMaps(snapshot);
  next.pendingBlobs.delete(id);
  emit({ ...snapshot, ...next });
}

export function markPhotoRemote(id: string): void {
  const next = cloneMaps(snapshot);
  next.pendingBlobs.delete(id);
  next.remotePhotoIds.add(id);
  emit({ ...snapshot, ...next });
}

export function cachePhotoBlob(id: string, blob: Blob): void {
  const next = cloneMaps(snapshot);
  next.pendingBlobs.set(id, blob);
  next.remotePhotoIds.add(id);
  emit({ ...snapshot, ...next });
}

export function dropPhoto(id: string): void {
  const next = cloneMaps(snapshot);
  next.pendingBlobs.delete(id);
  next.remotePhotoIds.delete(id);
  emit({ ...snapshot, ...next });
}

export function listRecipes(): Recipe[] {
  return [...snapshot.recipes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getRecipe(id: string): Recipe | undefined {
  return snapshot.recipes.get(id);
}

export function listChat(recipeId: string): ChatMessage[] {
  return [...snapshot.chat.values()]
    .filter((message) => message.recipeId === recipeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getCook(recipeId: string): CookStateRow | undefined {
  return snapshot.cook.get(recipeId);
}

export function getPendingBlob(id: string): Blob | undefined {
  return snapshot.pendingBlobs.get(id);
}

export function listAllChat(): ChatMessage[] {
  return [...snapshot.chat.values()];
}

export function listAllCook(): CookStateRow[] {
  return [...snapshot.cook.values()];
}

export function listPhotoIds(): string[] {
  const ids = new Set<string>(snapshot.remotePhotoIds);
  for (const id of snapshot.pendingBlobs.keys()) {
    ids.add(id);
  }
  return [...ids];
}

export function discardLegacyCookDb(): void {
  try {
    indexedDB.deleteDatabase('cook');
  } catch {
    // private mode / missing API
  }
  try {
    localStorage.removeItem('cook.ownerUid');
    localStorage.removeItem('cook.hasSeeded');
  } catch {
    // ignore
  }
}
