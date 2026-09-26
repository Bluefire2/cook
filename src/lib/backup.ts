import { isUsableRecipe } from './recipeShape';
import type { CookStateRow } from './useCookState';
import type { ChatMessage, Collection, Recipe } from './types';
import {
  addPendingBlob,
  captureSnapshot,
  chatParentIsShared,
  cookParentIsShared,
  getPendingBlob,
  isSharedCollection,
  isSharedRecipe,
  listAllChat,
  listAllCook,
  listCollections,
  listRecipes,
  markPhotoRemote,
  ownedBackupGraphIds,
  restoreSnapshot,
  upsertChat,
  upsertCollection,
  upsertCook,
  upsertRecipe,
} from './libraryMemory';
import { compactRecipe } from './compactRecipe';
import { compactCollection, compactCollectionName } from './compactCollection';
import { recipePhotoIds } from './recipePhotos';
import { fetchPhotoBlob, postPhoto, pushOps, type RemoteResult } from './remote';
import type { PushOp } from './pushOps';
import { SHARED_PARENT_OWNER_SUB_FIELD } from './pushReasons';
import {
  backupGraphIds,
  decideBackupImportMode,
  remapBackupImport,
} from './backupImportRemap';

interface BackupPhoto {
  id: string;
  type: string;
  base64: string;
  createdAt: number;
}

interface BackupFile {
  app: 'cook';
  version: 1 | 2 | 3;
  exportedAt: number;
  /** Google `sub` of the account that exported this file (optional on legacy backups). */
  exportedBySub?: string;
  recipes: unknown[];
  chatMessages: ChatMessage[];
  photos: BackupPhoto[];
  cookState?: CookStateRow[];
  collections?: unknown[];
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function attributePhotos(
  recipes: Recipe[],
  chatMessages: ChatMessage[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const recipe of recipes) {
    for (const photoId of recipePhotoIds(recipe)) {
      if (!map.has(photoId)) {
        map.set(photoId, recipe.id);
      }
    }
  }
  for (const message of chatMessages) {
    for (const photoId of message.photoIds ?? []) {
      if (!map.has(photoId)) {
        map.set(photoId, message.recipeId);
      }
    }
  }
  return map;
}

function withoutImportedProvenance<T extends object>(row: T): T {
  if (!Object.prototype.hasOwnProperty.call(row, SHARED_PARENT_OWNER_SUB_FIELD)) {
    return row;
  }
  const copy = { ...row } as T & Record<string, unknown>;
  delete copy[SHARED_PARENT_OWNER_SUB_FIELD];
  return copy;
}

export async function exportLibrary(currentSub: string): Promise<Blob> {
  const recipes = listRecipes().filter((recipe) => !isSharedRecipe(recipe.id));
  const chatMessages = listAllChat()
    .filter((message) => !chatParentIsShared(message.id, message.recipeId))
    .map(withoutImportedProvenance);
  const cookState = listAllCook()
    .filter((row) => !cookParentIsShared(row.recipeId))
    .map(withoutImportedProvenance);
  const collections = listCollections().filter(
    (collection) => !isSharedCollection(collection.id),
  );
  // Photo attribution runs after the shared-parent filter, so an attachment
  // that belongs only to an omitted chat row is not exported.
  const photoIds = [...attributePhotos(recipes, chatMessages).keys()];

  const photos: BackupPhoto[] = [];
  for (const id of photoIds) {
    let blob = getPendingBlob(id);
    if (!blob) {
      const fetched = await fetchPhotoBlob(id, undefined);
      if (fetched === null || fetched === 'signedOut') {
        continue;
      }
      blob = fetched;
    }
    photos.push({
      id,
      type: blob.type || 'image/jpeg',
      base64: await blobToBase64(blob),
      createdAt: Date.now(),
    });
  }

  const backup: BackupFile = {
    app: 'cook',
    version: 3,
    exportedAt: Date.now(),
    exportedBySub: currentSub,
    recipes,
    chatMessages,
    cookState,
    collections,
    photos,
  };

  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

function isUsableCollection(raw: unknown): raw is Collection {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id === '') {
    return false;
  }
  if (compactCollectionName(row.name) === undefined) {
    return false;
  }
  if (!Array.isArray(row.recipeIds)) {
    return false;
  }
  if (typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number') {
    return false;
  }
  return true;
}

/**
 * Drops chat and cook rows whose recipe is not a usable recipe entity in this
 * backup, and photos attributable only to those rows. Recipe entities stay.
 * Legacy orphan dependents are not restorable under the server parent
 * invariant; this does not synthesize parent recipes.
 */
function sanitizeDanglingDependents(
  recipes: Recipe[],
  collections: Collection[],
  chatMessages: ChatMessage[],
  cookState: CookStateRow[],
): {
  recipes: Recipe[];
  collections: Collection[];
  chatMessages: ChatMessage[];
  cookState: CookStateRow[];
  omitPhotoIds: Set<string>;
} {
  const usableIds = new Set(recipes.map((recipe) => recipe.id));
  const keptChat = chatMessages.filter((message) => usableIds.has(message.recipeId));
  const keptCook = cookState.filter((row) => usableIds.has(row.recipeId));
  const keptPhotoIds = new Set(attributePhotos(recipes, keptChat).keys());
  const omitPhotoIds = new Set<string>();
  for (const message of chatMessages) {
    if (usableIds.has(message.recipeId)) {
      continue;
    }
    for (const photoId of message.photoIds ?? []) {
      if (!keptPhotoIds.has(photoId)) {
        omitPhotoIds.add(photoId);
      }
    }
  }
  return {
    recipes,
    collections,
    chatMessages: keptChat,
    cookState: keptCook,
    omitPhotoIds,
  };
}

function importPushError(result: Exclude<RemoteResult, 'ok'>): Error {
  return new Error(
    result === 'signedOut'
      ? 'Please sign in again — your session expired.'
      : "Couldn't import the backup.",
  );
}

/** Merges a backup, preserving the whole graph only when provenance or owned overlap says it is local. */
export async function importLibrary(
  file: Blob,
  currentSub: string,
): Promise<{ imported: number; skipped: number }> {
  const backup = JSON.parse(await file.text()) as BackupFile;
  if (backup.app !== 'cook' || !Array.isArray(backup.recipes)) {
    throw new Error("That file doesn't look like a Sous backup.");
  }

  const recipes = backup.recipes.filter(isUsableRecipe).map(compactRecipe);
  const skipped = backup.recipes.length - recipes.length;
  const collections = (backup.collections ?? [])
    .filter(isUsableCollection)
    .map(compactCollection);
  const chatMessages = (backup.chatMessages ?? []).map(withoutImportedProvenance);
  const cookState = (backup.cookState ?? []).map(withoutImportedProvenance);
  const importEntities = {
    recipes,
    collections,
    chatMessages,
    cookState,
    backupPhotoIds: (backup.photos ?? []).map((p) => p.id),
  };
  const mode = decideBackupImportMode(
    backup.exportedBySub,
    currentSub,
    backupGraphIds(importEntities),
    ownedBackupGraphIds(),
  );
  const remapped = remapBackupImport(
    importEntities,
    mode,
    () => crypto.randomUUID(),
  );
  // Mode uses the full graph, including dangling chat/cook. Those rows are
  // removed only from the write set, after preserve-versus-clone.
  const kept = sanitizeDanglingDependents(
    remapped.recipes,
    remapped.collections,
    remapped.chatMessages,
    remapped.cookState,
  );
  const importRecipes = kept.recipes;
  const importCollections = kept.collections;
  const importChat = kept.chatMessages;
  const importCook = kept.cookState;
  const photoAttribution = attributePhotos(importRecipes, importChat);

  const keptPhotos = (backup.photos ?? []).flatMap((photo) => {
    const id = remapped.photoIdMap.get(photo.id) ?? photo.id;
    if (kept.omitPhotoIds.has(id)) {
      return [];
    }
    return [{ ...photo, id }];
  });
  const photos = await Promise.all(
    keptPhotos.map(async (photo) => ({
      id: photo.id,
      blob: await (await fetch(`data:${photo.type};base64,${photo.base64}`)).blob(),
      createdAt: photo.createdAt,
    })),
  );

  const previous = captureSnapshot();
  try {
    for (const photo of photos) {
      addPendingBlob(photo.id, photo.blob);
    }
    for (const recipe of importRecipes) {
      upsertRecipe(recipe);
    }
    for (const collection of importCollections) {
      upsertCollection(collection);
    }
    for (const message of importChat) {
      upsertChat(message);
    }
    for (const row of importCook) {
      upsertCook(row);
    }

    // Remote import is best-effort across requests. Recipe puts are
    // acknowledged before photo bytes and dependent puts. A failure after
    // the recipe phase can leave accepted server rows; the next refresh
    // reveals them. restoreSnapshot undoes this local copy.
    const recipeOps: PushOp[] = importRecipes.map((recipe) => ({
      kind: 'recipe.put',
      payload: recipe,
    }));
    const recipeResult = await pushOps(recipeOps);
    if (recipeResult !== 'ok') {
      throw importPushError(recipeResult);
    }

    for (const [photoId, recipeId] of photoAttribution) {
      const photo = photos.find((p) => p.id === photoId);
      if (!photo) {
        continue;
      }
      const uploaded = await postPhoto(
        photoId,
        recipeId,
        photo.createdAt,
        photo.blob,
      );
      if (uploaded !== 'ok') {
        throw new Error("Couldn't upload a photo from the backup.");
      }
      markPhotoRemote(photoId);
    }

    const dependentOps: PushOp[] = [];
    for (const collection of importCollections) {
      dependentOps.push({ kind: 'collection.put', payload: collection });
    }
    for (const message of importChat) {
      dependentOps.push({ kind: 'chat.put', payload: message });
    }
    for (const row of importCook) {
      dependentOps.push({
        kind: 'cookState.put',
        payload: { ...row, updatedAt: Date.now() },
      });
    }
    const dependentResult = await pushOps(dependentOps);
    if (dependentResult !== 'ok') {
      throw importPushError(dependentResult);
    }

    return { imported: importRecipes.length, skipped };
  } catch (err) {
    restoreSnapshot(previous);
    throw err;
  }
}
