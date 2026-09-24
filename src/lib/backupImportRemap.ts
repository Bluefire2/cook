import type { CookStateRow } from './useCookState';
import type { ChatMessage, Collection, Recipe } from './types';
import { recipePhotoIds } from './recipePhotos';

export type UuidGenerator = () => string;

export type BackupImportMode = 'preserve' | 'clone';

/** IDs are compared only within their entity/reference namespace. */
export interface BackupGraphIds {
  recipeIds: ReadonlySet<string>;
  collectionIds: ReadonlySet<string>;
  chatMessageIds: ReadonlySet<string>;
  photoIds: ReadonlySet<string>;
}

function overlaps(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const id of left) {
    if (right.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * Chooses one mode for the complete import graph. Legacy backups are
 * idempotent only when one of their namespaced IDs already exists in the
 * current account's owned graph.
 */
export function decideBackupImportMode(
  exportedBySub: string | undefined,
  currentSub: string,
  backupIds: BackupGraphIds,
  existingOwnedIds: BackupGraphIds,
): BackupImportMode {
  if (exportedBySub !== undefined) {
    return exportedBySub === currentSub ? 'preserve' : 'clone';
  }
  return overlaps(backupIds.recipeIds, existingOwnedIds.recipeIds)
    || overlaps(backupIds.collectionIds, existingOwnedIds.collectionIds)
    || overlaps(backupIds.chatMessageIds, existingOwnedIds.chatMessageIds)
    || overlaps(backupIds.photoIds, existingOwnedIds.photoIds)
    ? 'preserve'
    : 'clone';
}

function remapId(map: Map<string, string>, id: string): string {
  return map.get(id) ?? id;
}

function remapRecipe(recipe: Recipe, recipeIdMap: Map<string, string>, photoIdMap: Map<string, string>): Recipe {
  return {
    ...recipe,
    id: remapId(recipeIdMap, recipe.id),
    photoId:
      recipe.photoId === undefined
        ? undefined
        : remapId(photoIdMap, recipe.photoId),
    galleryPhotoIds: recipe.galleryPhotoIds?.map((id) => remapId(photoIdMap, id)),
  };
}

function remapCollection(
  collection: Collection,
  collectionIdMap: Map<string, string>,
  recipeIdMap: Map<string, string>,
): Collection {
  return {
    ...collection,
    id: remapId(collectionIdMap, collection.id),
    recipeIds: collection.recipeIds.map((id) => remapId(recipeIdMap, id)),
  };
}

function remapChatMessage(
  message: ChatMessage,
  chatIdMap: Map<string, string>,
  recipeIdMap: Map<string, string>,
  photoIdMap: Map<string, string>,
): ChatMessage {
  return {
    ...message,
    id: remapId(chatIdMap, message.id),
    recipeId: remapId(recipeIdMap, message.recipeId),
    photoIds: message.photoIds?.map((id) => remapId(photoIdMap, id)),
  };
}

function remapCookRow(row: CookStateRow, recipeIdMap: Map<string, string>): CookStateRow {
  return {
    ...row,
    recipeId: remapId(recipeIdMap, row.recipeId),
  };
}

export interface BackupImportEntities {
  recipes: Recipe[];
  collections: Collection[];
  chatMessages: ChatMessage[];
  cookState: CookStateRow[];
  /** Photo ids present in the backup file (before remap). */
  backupPhotoIds: string[];
}

export interface RemappedBackupImport {
  recipes: Recipe[];
  collections: Collection[];
  chatMessages: ChatMessage[];
  cookState: CookStateRow[];
  /** Old photo id → new photo id (identity when preserving). */
  photoIdMap: Map<string, string>;
}

export function backupGraphIds(input: BackupImportEntities): BackupGraphIds {
  const recipeIds = new Set<string>();
  const collectionIds = new Set<string>();
  const chatMessageIds = new Set<string>();
  const photoIds = new Set(input.backupPhotoIds);

  for (const recipe of input.recipes) {
    recipeIds.add(recipe.id);
    for (const id of recipePhotoIds(recipe)) {
      photoIds.add(id);
    }
  }
  for (const collection of input.collections) {
    collectionIds.add(collection.id);
    for (const id of collection.recipeIds) {
      recipeIds.add(id);
    }
  }
  for (const message of input.chatMessages) {
    chatMessageIds.add(message.id);
    recipeIds.add(message.recipeId);
    for (const id of message.photoIds ?? []) {
      photoIds.add(id);
    }
  }
  for (const row of input.cookState) {
    recipeIds.add(row.recipeId);
  }

  return { recipeIds, collectionIds, chatMessageIds, photoIds };
}

export function remapBackupImport(
  input: BackupImportEntities,
  mode: BackupImportMode,
  nextUuid: UuidGenerator,
): RemappedBackupImport {
  const graphIds = backupGraphIds(input);
  if (mode === 'preserve') {
    return {
      recipes: input.recipes,
      collections: input.collections,
      chatMessages: input.chatMessages,
      cookState: input.cookState,
      photoIdMap: new Map([...graphIds.photoIds].map((id) => [id, id])),
    };
  }

  const recipeIdMap = new Map<string, string>();
  for (const id of graphIds.recipeIds) {
    recipeIdMap.set(id, nextUuid());
  }

  const collectionIdMap = new Map<string, string>();
  for (const id of graphIds.collectionIds) {
    collectionIdMap.set(id, nextUuid());
  }

  const photoIdMap = new Map<string, string>();
  for (const id of graphIds.photoIds) {
    photoIdMap.set(id, nextUuid());
  }

  const chatIdMap = new Map<string, string>();
  for (const id of graphIds.chatMessageIds) {
    chatIdMap.set(id, nextUuid());
  }

  return {
    recipes: input.recipes.map((r) => remapRecipe(r, recipeIdMap, photoIdMap)),
    collections: input.collections.map((c) =>
      remapCollection(c, collectionIdMap, recipeIdMap),
    ),
    chatMessages: input.chatMessages.map((m) =>
      remapChatMessage(m, chatIdMap, recipeIdMap, photoIdMap),
    ),
    cookState: input.cookState.map((row) => remapCookRow(row, recipeIdMap)),
    photoIdMap,
  };
}
