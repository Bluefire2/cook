import { isUsableRecipe } from './recipeShape';
import type { CookStateRow } from './useCookState';
import type { ChatMessage, Collection, Recipe } from './types';
import {
  addPendingBlob,
  captureSnapshot,
  getPendingBlob,
  listAllChat,
  listAllCook,
  listCollections,
  listPhotoIds,
  listRecipes,
  markPhotoRemote,
  restoreSnapshot,
  upsertChat,
  upsertCollection,
  upsertCook,
  upsertRecipe,
} from './libraryMemory';
import { compactRecipe } from './compactRecipe';
import { compactCollection, compactCollectionName } from './compactCollection';
import { recipePhotoIds } from './recipePhotos';
import { fetchPhotoBlob, postPhoto, pushOps } from './remote';
import type { PushOp } from './pushOps';

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

export async function exportLibrary(): Promise<Blob> {
  const recipes = listRecipes();
  const chatMessages = listAllChat();
  const cookState = listAllCook();
  const collections = listCollections();
  const photoIds = listPhotoIds();

  const photos: BackupPhoto[] = [];
  for (const id of photoIds) {
    let blob = getPendingBlob(id);
    if (!blob) {
      const fetched = await fetchPhotoBlob(id);
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

/** Merges a backup into the account library (existing ids get overwritten). */
export async function importLibrary(
  file: Blob,
): Promise<{ imported: number; skipped: number }> {
  const backup = JSON.parse(await file.text()) as BackupFile;
  if (backup.app !== 'cook' || !Array.isArray(backup.recipes)) {
    throw new Error("That file doesn't look like a Sous backup.");
  }

  const recipes = backup.recipes.filter(isUsableRecipe).map(compactRecipe);
  const skipped = backup.recipes.length - recipes.length;
  const chatMessages = backup.chatMessages ?? [];
  const photoAttribution = attributePhotos(recipes, chatMessages);

  const photos = await Promise.all(
    (backup.photos ?? []).map(async (p) => ({
      id: p.id,
      blob: await (await fetch(`data:${p.type};base64,${p.base64}`)).blob(),
      createdAt: p.createdAt,
    })),
  );

  const previous = captureSnapshot();
  try {
    for (const photo of photos) {
      addPendingBlob(photo.id, photo.blob);
    }
    for (const recipe of recipes) {
      upsertRecipe(recipe);
    }
    const collections = (backup.collections ?? [])
      .filter(isUsableCollection)
      .map(compactCollection);
    for (const collection of collections) {
      upsertCollection(collection);
    }
    for (const message of chatMessages) {
      upsertChat(message);
    }
    if (backup.cookState) {
      for (const row of backup.cookState) {
        upsertCook(row);
      }
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

    const ops: PushOp[] = [];
    for (const recipe of recipes) {
      ops.push({ kind: 'recipe.put', payload: recipe });
    }
    for (const collection of collections) {
      ops.push({ kind: 'collection.put', payload: collection });
    }
    for (const message of chatMessages) {
      ops.push({ kind: 'chat.put', payload: message });
    }
    if (backup.cookState) {
      for (const row of backup.cookState) {
        ops.push({
          kind: 'cookState.put',
          payload: { ...row, updatedAt: Date.now() },
        });
      }
    }
    const result = await pushOps(ops);
    if (result !== 'ok') {
      throw new Error(
        result === 'signedOut'
          ? 'Please sign in again — your session expired.'
          : "Couldn't import the backup.",
      );
    }

    return { imported: recipes.length, skipped };
  } catch (err) {
    restoreSnapshot(previous);
    throw err;
  }
}
