import { recipePhotoIds } from './recipePhotos';
import type { BackupGraphIds } from './backupImportRemap';
import type { ChatMessage, Collection, Recipe } from './types';
import type { CookStateRow } from './useCookState';

export type ItemOrigin = { kind: 'own' } | { kind: 'shared'; ownerSub: string };

export type LibrarySnapshot = {
  recipes: ReadonlyMap<string, Recipe>;
  collections: ReadonlyMap<string, Collection>;
  chat: ReadonlyMap<string, ChatMessage>;
  cook: ReadonlyMap<string, CookStateRow>;
  remotePhotoIds: ReadonlySet<string>;
  pendingBlobs: ReadonlyMap<string, Blob>;
  recipeOrigins: ReadonlyMap<string, ItemOrigin>;
  collectionOrigins: ReadonlyMap<string, ItemOrigin>;
  grantCounts: ReadonlyMap<string, number>;
  loaded: boolean;
};

const listeners = new Set<() => void>();

function empty(loaded: boolean): LibrarySnapshot {
  return {
    recipes: new Map(),
    collections: new Map(),
    chat: new Map(),
    cook: new Map(),
    remotePhotoIds: new Set(),
    pendingBlobs: new Map(),
    recipeOrigins: new Map(),
    collectionOrigins: new Map(),
    grantCounts: new Map(),
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
  collections: Map<string, Collection>;
  chat: Map<string, ChatMessage>;
  cook: Map<string, CookStateRow>;
  remotePhotoIds: Set<string>;
  pendingBlobs: Map<string, Blob>;
  recipeOrigins: Map<string, ItemOrigin>;
  collectionOrigins: Map<string, ItemOrigin>;
  grantCounts: Map<string, number>;
} {
  return {
    recipes: new Map(from.recipes),
    collections: new Map(from.collections),
    chat: new Map(from.chat),
    cook: new Map(from.cook),
    remotePhotoIds: new Set(from.remotePhotoIds),
    pendingBlobs: new Map(from.pendingBlobs),
    recipeOrigins: new Map(from.recipeOrigins),
    collectionOrigins: new Map(from.collectionOrigins),
    grantCounts: new Map(from.grantCounts),
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

export function captureSnapshot(): LibrarySnapshot {
  return { ...cloneMaps(snapshot), loaded: snapshot.loaded };
}

export function restoreSnapshot(previous: LibrarySnapshot): void {
  emit({ ...cloneMaps(previous), loaded: previous.loaded });
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

type OwnedPullSnapshot = {
  recipes: Map<string, Recipe>;
  collections: Map<string, Collection>;
  chat: Map<string, ChatMessage>;
  cook: Map<string, CookStateRow>;
  remotePhotoIds: Set<string>;
};

type SharedPullSnapshot = {
  recipes: Map<string, Recipe>;
  collections: Map<string, Collection>;
  remotePhotoIds: Set<string>;
  recipeOrigins: Map<string, ItemOrigin>;
  collectionOrigins: Map<string, ItemOrigin>;
};

export function replaceFromPull(next: OwnedPullSnapshot): void {
  const recipeOrigins = new Map<string, ItemOrigin>();
  for (const id of next.recipes.keys()) {
    recipeOrigins.set(id, { kind: 'own' });
  }
  const collectionOrigins = new Map<string, ItemOrigin>();
  for (const id of next.collections.keys()) {
    collectionOrigins.set(id, { kind: 'own' });
  }
  emit({
    recipes: next.recipes,
    collections: next.collections,
    chat: next.chat,
    cook: next.cook,
    remotePhotoIds: next.remotePhotoIds,
    pendingBlobs: snapshot.pendingBlobs,
    recipeOrigins,
    collectionOrigins,
    grantCounts: snapshot.grantCounts,
    loaded: true,
  });
}

export function replaceFromPullWithShared(
  owned: OwnedPullSnapshot,
  shared: SharedPullSnapshot,
): void {
  const recipes = new Map(owned.recipes);
  const recipeOrigins = new Map<string, ItemOrigin>();
  for (const id of recipes.keys()) {
    recipeOrigins.set(id, { kind: 'own' });
  }
  for (const [id, recipe] of shared.recipes) {
    if (recipes.has(id)) {
      continue;
    }
    recipes.set(id, recipe);
    const origin = shared.recipeOrigins.get(id);
    if (origin) {
      recipeOrigins.set(id, origin);
    }
  }

  const collections = new Map(owned.collections);
  const collectionOrigins = new Map<string, ItemOrigin>();
  for (const id of collections.keys()) {
    collectionOrigins.set(id, { kind: 'own' });
  }
  for (const [id, collection] of shared.collections) {
    if (collections.has(id)) {
      continue;
    }
    collections.set(id, collection);
    const origin = shared.collectionOrigins.get(id);
    if (origin) {
      collectionOrigins.set(id, origin);
    }
  }

  emit({
    recipes,
    collections,
    chat: owned.chat,
    cook: owned.cook,
    remotePhotoIds: new Set([...owned.remotePhotoIds, ...shared.remotePhotoIds]),
    pendingBlobs: snapshot.pendingBlobs,
    recipeOrigins,
    collectionOrigins,
    grantCounts: snapshot.grantCounts,
    loaded: true,
  });
}

export function mergeSharedFromPull(next: SharedPullSnapshot): void {
  const maps = cloneMaps(snapshot);
  for (const [id, recipe] of next.recipes) {
    if (maps.recipeOrigins.get(id)?.kind === 'own' || maps.recipes.has(id)) {
      continue;
    }
    maps.recipes.set(id, recipe);
    const origin = next.recipeOrigins.get(id);
    if (origin) {
      maps.recipeOrigins.set(id, origin);
    }
  }
  for (const [id, collection] of next.collections) {
    if (maps.collectionOrigins.get(id)?.kind === 'own' || maps.collections.has(id)) {
      continue;
    }
    maps.collections.set(id, collection);
    const origin = next.collectionOrigins.get(id);
    if (origin) {
      maps.collectionOrigins.set(id, origin);
    }
  }
  for (const id of next.remotePhotoIds) {
    maps.remotePhotoIds.add(id);
  }
  emit({ ...snapshot, ...maps });
}

export function upsertRecipe(recipe: Recipe): void {
  const next = cloneMaps(snapshot);
  next.recipes.set(recipe.id, recipe);
  next.recipeOrigins.set(recipe.id, { kind: 'own' });
  emit({ ...snapshot, ...next });
}

export function removeRecipeLocal(id: string): void {
  const next = cloneMaps(snapshot);
  const recipe = next.recipes.get(id);
  next.recipes.delete(id);
  next.recipeOrigins.delete(id);
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

export function listCollections(): Collection[] {
  return [...snapshot.collections.values()].sort((a, b) => {
    const name = a.name.localeCompare(b.name);
    return name !== 0 ? name : a.id.localeCompare(b.id);
  });
}

export function countOwnedNamedCollections(): number {
  let count = 0;
  for (const id of snapshot.collections.keys()) {
    if (snapshot.collectionOrigins.get(id)?.kind !== 'shared') {
      count += 1;
    }
  }
  return count;
}

export function getCollection(id: string): Collection | undefined {
  return snapshot.collections.get(id);
}

export function upsertCollection(collection: Collection): void {
  const next = cloneMaps(snapshot);
  next.collections.set(collection.id, collection);
  if (!next.collectionOrigins.has(collection.id)) {
    next.collectionOrigins.set(collection.id, { kind: 'own' });
  }
  emit({ ...snapshot, ...next });
}

export function removeCollectionLocal(id: string): void {
  const next = cloneMaps(snapshot);
  next.collections.delete(id);
  next.collectionOrigins.delete(id);
  next.grantCounts.delete(id);
  emit({ ...snapshot, ...next });
}

export function getRecipeOrigin(id: string): ItemOrigin | undefined {
  return snapshot.recipeOrigins.get(id);
}

export function getCollectionOrigin(id: string): ItemOrigin | undefined {
  return snapshot.collectionOrigins.get(id);
}

export function isSharedRecipe(id: string): boolean {
  return snapshot.recipeOrigins.get(id)?.kind === 'shared';
}

export function isSharedCollection(id: string): boolean {
  return snapshot.collectionOrigins.get(id)?.kind === 'shared';
}

export function photoOwnerSub(photoId: string): string | undefined {
  for (const recipe of snapshot.recipes.values()) {
    if (!recipePhotoIds(recipe).includes(photoId)) {
      continue;
    }
    const origin = snapshot.recipeOrigins.get(recipe.id);
    if (origin?.kind === 'shared') {
      return origin.ownerSub;
    }
    return undefined;
  }
  return undefined;
}

export function setGrantCount(collectionId: string, count: number): void {
  if (snapshot.grantCounts.get(collectionId) === count) {
    return;
  }
  const next = cloneMaps(snapshot);
  next.grantCounts.set(collectionId, count);
  emit({ ...snapshot, ...next });
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

/**
 * Returns namespaced IDs with evidence of belonging to this account.
 * Incoming shared rows and references rooted only in those rows are excluded.
 */
export function ownedBackupGraphIds(): BackupGraphIds {
  const recipeIds = new Set<string>();
  const collectionIds = new Set<string>();
  const chatMessageIds = new Set<string>();
  const photoIds = new Set<string>();
  const isOwnedRecipeId = (id: string) =>
    snapshot.recipeOrigins.get(id)?.kind !== 'shared';

  for (const recipe of snapshot.recipes.values()) {
    if (!isOwnedRecipeId(recipe.id)) {
      continue;
    }
    recipeIds.add(recipe.id);
    for (const id of recipePhotoIds(recipe)) {
      photoIds.add(id);
    }
  }
  for (const collection of snapshot.collections.values()) {
    if (snapshot.collectionOrigins.get(collection.id)?.kind === 'shared') {
      continue;
    }
    collectionIds.add(collection.id);
    for (const id of collection.recipeIds) {
      if (isOwnedRecipeId(id)) {
        recipeIds.add(id);
      }
    }
  }
  for (const message of snapshot.chat.values()) {
    chatMessageIds.add(message.id);
    if (!isOwnedRecipeId(message.recipeId)) {
      continue;
    }
    recipeIds.add(message.recipeId);
    for (const id of message.photoIds ?? []) {
      photoIds.add(id);
    }
  }
  for (const row of snapshot.cook.values()) {
    if (isOwnedRecipeId(row.recipeId)) {
      recipeIds.add(row.recipeId);
    }
  }

  return { recipeIds, collectionIds, chatMessageIds, photoIds };
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
