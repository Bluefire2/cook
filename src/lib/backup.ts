import { db } from './db';
import type { ChatMessage, Recipe } from './types';

interface BackupPhoto {
  id: string;
  type: string;
  base64: string;
  createdAt: number;
}

interface BackupFile {
  app: 'cook';
  version: 1;
  exportedAt: number;
  recipes: Recipe[];
  chatMessages: ChatMessage[];
  photos: BackupPhoto[];
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
  const [recipes, chatMessages, photos] = await Promise.all([
    db.recipes.toArray(),
    db.chatMessages.toArray(),
    db.photos.toArray(),
  ]);

  const backup: BackupFile = {
    app: 'cook',
    version: 1,
    exportedAt: Date.now(),
    recipes,
    chatMessages,
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
export async function importLibrary(file: Blob): Promise<number> {
  const backup = JSON.parse(await file.text()) as BackupFile;
  if (backup.app !== 'cook' || !Array.isArray(backup.recipes)) {
    throw new Error("That file doesn't look like a Cook backup.");
  }

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
    [db.recipes, db.chatMessages, db.photos],
    async () => {
      await db.recipes.bulkPut(backup.recipes);
      await db.chatMessages.bulkPut(backup.chatMessages ?? []);
      await db.photos.bulkPut(photos);
    },
  );

  return backup.recipes.length;
}
