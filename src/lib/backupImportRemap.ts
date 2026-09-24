import type { CookStateRow } from './useCookState';
import type { ChatMessage, Collection, Recipe } from './types';
import { recipePhotoIds } from './recipePhotos';

export type UuidGenerator = () => string;

/** Clone when provenance is missing or from another account. */
export function shouldCloneBackupIds(
  exportedBySub: string | undefined,
  currentSub: string,
): boolean {
  return exportedBySub === undefined || exportedBySub !== currentSub;
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

export function remapBackupImport(
  input: BackupImportEntities,
  clone: boolean,
  nextUuid: UuidGenerator,
): RemappedBackupImport {
  if (!clone) {
    return {
      recipes: input.recipes,
      collections: input.collections,
      chatMessages: input.chatMessages,
      cookState: input.cookState,
      photoIdMap: new Map(input.backupPhotoIds.map((id) => [id, id])),
    };
  }

  const recipeIdMap = new Map<string, string>();
  for (const recipe of input.recipes) {
    recipeIdMap.set(recipe.id, nextUuid());
  }

  const collectionIdMap = new Map<string, string>();
  for (const collection of input.collections) {
    collectionIdMap.set(collection.id, nextUuid());
  }

  const photoIdMap = new Map<string, string>();
  const seenPhotos = new Set<string>();
  for (const id of input.backupPhotoIds) {
    seenPhotos.add(id);
  }
  for (const recipe of input.recipes) {
    for (const id of recipePhotoIds(recipe)) {
      seenPhotos.add(id);
    }
  }
  for (const message of input.chatMessages) {
    for (const id of message.photoIds ?? []) {
      seenPhotos.add(id);
    }
  }
  for (const id of seenPhotos) {
    photoIdMap.set(id, nextUuid());
  }

  const chatIdMap = new Map<string, string>();
  for (const message of input.chatMessages) {
    chatIdMap.set(message.id, nextUuid());
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
