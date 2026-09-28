import { sortCookLogs } from './cookLogShape';
import { recipePhotoIds } from './recipePhotos';
import type { BackupGraphIds } from './backupImportRemap';
import type { ChatMessage, Collection, CookLog, Recipe } from './types';
import type { CookStateRow } from './useCookState';

/**
 * What this session may do to a row. `owner` is the session's own tree.
 * A shared row is `viewer` unless its grant (or, for a recipe, any shared
 * collection listing it) says `editor`. Memory only, set when a pull
 * publishes; never a `Recipe` or `Collection` field.
 */
export type LibraryAccess = 'owner' | 'editor' | 'viewer';

export type ItemOrigin =
  | { kind: 'own' }
  | {
      kind: 'shared';
      ownerSub: string;
      ownerEmail?: string;
      /** Missing means viewer. */
      access?: 'editor' | 'viewer';
    };

export function originAccess(origin: ItemOrigin | undefined): LibraryAccess | undefined {
  if (origin === undefined) {
    return undefined;
  }
  if (origin.kind === 'own') {
    return 'owner';
  }
  return origin.access === 'editor' ? 'editor' : 'viewer';
}

/**
 * A shared recipe is editable when any shared collection that lists it was
 * granted as editor: the stronger role wins, as it does on the server.
 */
export function withSharedRecipeAccess(
  recipeOrigins: ReadonlyMap<string, ItemOrigin>,
  collections: ReadonlyMap<string, Collection>,
  collectionOrigins: ReadonlyMap<string, ItemOrigin>,
): Map<string, ItemOrigin> {
  const editable = new Set<string>();
  for (const [id, collection] of collections) {
    if (originAccess(collectionOrigins.get(id)) !== 'editor') {
      continue;
    }
    for (const recipeId of collection.recipeIds) {
      editable.add(recipeId);
    }
  }
  const next = new Map<string, ItemOrigin>();
  for (const [id, origin] of recipeOrigins) {
    next.set(
      id,
      origin.kind === 'shared'
        ? { ...origin, access: editable.has(id) ? 'editor' : 'viewer' }
        : origin,
    );
  }
  return next;
}

export type LibrarySnapshot = {
  recipes: ReadonlyMap<string, Recipe>;
  collections: ReadonlyMap<string, Collection>;
  chat: ReadonlyMap<string, ChatMessage>;
  cook: ReadonlyMap<string, CookStateRow>;
  cookLogs: ReadonlyMap<string, CookLog>;
  remotePhotoIds: ReadonlySet<string>;
  pendingBlobs: ReadonlyMap<string, Blob>;
  recipeOrigins: ReadonlyMap<string, ItemOrigin>;
  collectionOrigins: ReadonlyMap<string, ItemOrigin>;
  /**
   * Server-derived shared parent owner for a viewer chat row, keyed by
   * message id. Absent means there is no persisted evidence the parent was
   * shared. Not part of ChatMessage or a version-3 backup.
   */
  chatParentOrigins: ReadonlyMap<string, string>;
  /** Same marker for cook rows, keyed by recipe id. */
  cookParentOrigins: ReadonlyMap<string, string>;
  loaded: boolean;
};

const listeners = new Set<() => void>();

function empty(loaded: boolean): LibrarySnapshot {
  return {
    recipes: new Map(),
    collections: new Map(),
    chat: new Map(),
    cook: new Map(),
    cookLogs: new Map(),
    remotePhotoIds: new Set(),
    pendingBlobs: new Map(),
    recipeOrigins: new Map(),
    collectionOrigins: new Map(),
    chatParentOrigins: new Map(),
    cookParentOrigins: new Map(),
    loaded,
  };
}

let snapshot: LibrarySnapshot = empty(false);

/**
 * Bumped when a local write starts. A pull that began at an older epoch, or
 * while a write was still open, must not replace the library: its snapshot
 * can still contain a recipe the write already deleted.
 */
let epoch = 0;
let openWrites = 0;

export function libraryEpoch(): number {
  return epoch;
}

export function localWritesOpen(): number {
  return openWrites;
}

export function beginLocalWrite(): number {
  openWrites += 1;
  epoch += 1;
  return epoch;
}

export function endLocalWrite(): void {
  if (openWrites > 0) {
    openWrites -= 1;
  }
}

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
  cookLogs: Map<string, CookLog>;
  remotePhotoIds: Set<string>;
  pendingBlobs: Map<string, Blob>;
  recipeOrigins: Map<string, ItemOrigin>;
  collectionOrigins: Map<string, ItemOrigin>;
  chatParentOrigins: Map<string, string>;
  cookParentOrigins: Map<string, string>;
} {
  return {
    recipes: new Map(from.recipes),
    collections: new Map(from.collections),
    chat: new Map(from.chat),
    cook: new Map(from.cook),
    cookLogs: new Map(from.cookLogs),
    remotePhotoIds: new Set(from.remotePhotoIds),
    pendingBlobs: new Map(from.pendingBlobs),
    recipeOrigins: new Map(from.recipeOrigins),
    collectionOrigins: new Map(from.collectionOrigins),
    chatParentOrigins: new Map(from.chatParentOrigins),
    cookParentOrigins: new Map(from.cookParentOrigins),
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
  cookLogs: Map<string, CookLog>;
  remotePhotoIds: Set<string>;
  chatParentOrigins?: ReadonlyMap<string, string>;
  cookParentOrigins?: ReadonlyMap<string, string>;
};

function copyOwnerMap(
  source: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(source ?? []);
}

export type SharedPullSnapshot = {
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
    cookLogs: next.cookLogs,
    remotePhotoIds: next.remotePhotoIds,
    pendingBlobs: snapshot.pendingBlobs,
    recipeOrigins,
    collectionOrigins,
    chatParentOrigins: copyOwnerMap(next.chatParentOrigins),
    cookParentOrigins: copyOwnerMap(next.cookParentOrigins),
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
    cookLogs: owned.cookLogs,
    remotePhotoIds: new Set([...owned.remotePhotoIds, ...shared.remotePhotoIds]),
    pendingBlobs: snapshot.pendingBlobs,
    recipeOrigins,
    collectionOrigins,
    chatParentOrigins: copyOwnerMap(owned.chatParentOrigins),
    cookParentOrigins: copyOwnerMap(owned.cookParentOrigins),
    loaded: true,
  });
}

/** `origin` defaults to own; an editor's optimistic save passes the shared origin through. */
export function upsertRecipe(recipe: Recipe, origin: ItemOrigin = { kind: 'own' }): void {
  const next = cloneMaps(snapshot);
  next.recipes.set(recipe.id, recipe);
  next.recipeOrigins.set(recipe.id, origin);
  emit({ ...snapshot, ...next });
}

export function removeRecipeLocal(id: string): void {
  const next = cloneMaps(snapshot);
  const recipe = next.recipes.get(id);
  next.recipes.delete(id);
  next.recipeOrigins.delete(id);
  next.cook.delete(id);
  next.cookParentOrigins.delete(id);
  for (const [messageId, message] of next.chat) {
    if (message.recipeId === id) {
      next.chat.delete(messageId);
      next.chatParentOrigins.delete(messageId);
      for (const photoId of message.photoIds ?? []) {
        next.pendingBlobs.delete(photoId);
        next.remotePhotoIds.delete(photoId);
      }
    }
  }
  for (const [logId, log] of next.cookLogs) {
    if (log.recipeId === id) {
      next.cookLogs.delete(logId);
      for (const photoId of log.photoIds ?? []) {
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

/**
 * Optimistic writes copy a live shared recipe origin into the sidecar so
 * export is safe before the next pull. A live owned origin clears it. A
 * missing origin leaves a persisted sidecar in place: revocation drops the
 * recipe before pull returns the stored marker, and that absence must not
 * wipe the marker.
 */
function assignInferredParentOrigin(
  sidecar: Map<string, string>,
  key: string,
  recipeId: string,
  recipeOrigins: Map<string, ItemOrigin>,
): void {
  const origin = recipeOrigins.get(recipeId);
  if (origin?.kind === 'shared' && origin.ownerSub !== '') {
    sidecar.set(key, origin.ownerSub);
    return;
  }
  if (origin?.kind === 'own') {
    sidecar.delete(key);
  }
}

export function upsertChat(message: ChatMessage): void {
  const next = cloneMaps(snapshot);
  next.chat.set(message.id, message);
  assignInferredParentOrigin(
    next.chatParentOrigins,
    message.id,
    message.recipeId,
    next.recipeOrigins,
  );
  emit({ ...snapshot, ...next });
}

export function clearChatLocal(recipeId: string): void {
  const next = cloneMaps(snapshot);
  for (const [messageId, message] of next.chat) {
    if (message.recipeId === recipeId) {
      next.chat.delete(messageId);
      next.chatParentOrigins.delete(messageId);
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
  assignInferredParentOrigin(
    next.cookParentOrigins,
    row.recipeId,
    row.recipeId,
    next.recipeOrigins,
  );
  emit({ ...snapshot, ...next });
}

export function upsertCookLog(log: CookLog): void {
  const next = cloneMaps(snapshot);
  next.cookLogs.set(log.id, log);
  emit({ ...snapshot, ...next });
}

export function removeCookLogLocal(id: string): void {
  const next = cloneMaps(snapshot);
  next.cookLogs.delete(id);
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
  emit({ ...snapshot, ...next });
}

export function getRecipeOrigin(id: string): ItemOrigin | undefined {
  return snapshot.recipeOrigins.get(id);
}

export function getCollectionOrigin(id: string): ItemOrigin | undefined {
  return snapshot.collectionOrigins.get(id);
}

export function recipeAccess(id: string): LibraryAccess | undefined {
  return originAccess(snapshot.recipeOrigins.get(id));
}

export function collectionAccess(id: string): LibraryAccess | undefined {
  return originAccess(snapshot.collectionOrigins.get(id));
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

export function listChat(recipeId: string): ChatMessage[] {
  return [...snapshot.chat.values()]
    .filter((message) => message.recipeId === recipeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getCook(recipeId: string): CookStateRow | undefined {
  return snapshot.cook.get(recipeId);
}

export function getCookLog(id: string): CookLog | undefined {
  return snapshot.cookLogs.get(id);
}

/** Newest cook first; every entry when `recipeId` is omitted. */
export function listCookLogs(recipeId?: string): CookLog[] {
  const logs = [...snapshot.cookLogs.values()];
  return sortCookLogs(
    recipeId === undefined ? logs : logs.filter((log) => log.recipeId === recipeId),
  );
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
 * True when the visible recipe origin or a persisted parent sidecar says
 * shared. Export and owned-overlap detection both use this so they cannot
 * drift. A missing sidecar is not shared: legacy orphans stay exportable.
 */
function parentSourcesSayShared(
  recipeId: string,
  sidecarOwner: string | undefined,
): boolean {
  if (snapshot.recipeOrigins.get(recipeId)?.kind === 'shared') {
    return true;
  }
  return sidecarOwner !== undefined && sidecarOwner !== '';
}

export function chatParentIsShared(messageId: string, recipeId: string): boolean {
  return parentSourcesSayShared(recipeId, snapshot.chatParentOrigins.get(messageId));
}

export function cookParentIsShared(recipeId: string): boolean {
  return parentSourcesSayShared(recipeId, snapshot.cookParentOrigins.get(recipeId));
}

/**
 * Returns namespaced IDs with evidence of belonging to this account.
 * Incoming shared rows are excluded. Chat and cook rows whose parent is
 * shared — by the visible recipe origin or the persisted sidecar — are
 * excluded together with their parent recipe reference and attachment photos.
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
    if (chatParentIsShared(message.id, message.recipeId)) {
      continue;
    }
    chatMessageIds.add(message.id);
    recipeIds.add(message.recipeId);
    for (const id of message.photoIds ?? []) {
      photoIds.add(id);
    }
  }
  for (const row of snapshot.cook.values()) {
    if (cookParentIsShared(row.recipeId)) {
      continue;
    }
    recipeIds.add(row.recipeId);
  }
  const cookLogIds = new Set<string>();
  for (const log of snapshot.cookLogs.values()) {
    if (!isOwnedRecipeId(log.recipeId)) {
      continue;
    }
    cookLogIds.add(log.id);
    recipeIds.add(log.recipeId);
    for (const id of log.photoIds ?? []) {
      photoIds.add(id);
    }
  }

  return { recipeIds, collectionIds, chatMessageIds, cookLogIds, photoIds };
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
