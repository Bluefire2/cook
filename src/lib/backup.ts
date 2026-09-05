import { db } from './db';
import { isUsableRecipe } from './recipeShape';
import type { CookStateRow } from './useCookState';
import type { ChatMessage } from './types';

interface BackupPhoto {
  id: string;
  type: string;
  base64: string;
  createdAt: number;
}

interface BackupFile {
  app: 'cook';
  version: 1 | 2;
  exportedAt: number;
  /** Whatever the user chose; only rows that pass isUsableRecipe reach the db. */
  recipes: unknown[];
  chatMessages: ChatMessage[];
  photos: BackupPhoto[];
  /** Present from v2. Older files omit it. */
  cookState?: CookStateRow[];
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

export async function exportLibrary(): Promise<Blob> {
  const [recipes, chatMessages, photos, cookState] = await Promise.all([
    db.recipes.toArray(),
    db.chatMessages.toArray(),
    db.photos.toArray(),
    db.cookState.toArray(),
  ]);

  const backup: BackupFile = {
    app: 'cook',
    version: 2,
    exportedAt: Date.now(),
    recipes,
    chatMessages,
    cookState,
    photos: await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        type: p.blob.type || 'image/jpeg',
        base64: await blobToBase64(p.blob),
        createdAt: p.createdAt,
      })),
    ),
  };

  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

/** Merges a backup into the library (existing ids get overwritten). */
export async function importLibrary(
  file: Blob,
): Promise<{ imported: number; skipped: number }> {
  const backup = JSON.parse(await file.text()) as BackupFile;
  if (backup.app !== 'cook' || !Array.isArray(backup.recipes)) {
    throw new Error("That file doesn't look like a Cook backup.");
  }

  const recipes = backup.recipes.filter(isUsableRecipe);
  const skipped = backup.recipes.length - recipes.length;

  const photos = await Promise.all(
    (backup.photos ?? []).map(async (p) => ({
      id: p.id,
      blob: await (
        await fetch(`data:${p.type};base64,${p.base64}`)
      ).blob(),
      createdAt: p.createdAt,
    })),
  );

  await db.transaction(
    'rw',
    [db.recipes, db.chatMessages, db.photos, db.cookState],
    async () => {
      await db.recipes.bulkPut(recipes);
      await db.chatMessages.bulkPut(backup.chatMessages ?? []);
      await db.photos.bulkPut(photos);
      if (backup.cookState) {
        await db.cookState.bulkPut(backup.cookState);
      } else {
        // v1 files have no progress. Drop leftover rows for overwritten ids
        // so restored recipes do not inherit this device's old ticks.
        await db.cookState.bulkDelete(recipes.map((r) => r.id));
      }
    },
  );

  return { imported: recipes.length, skipped };
}
