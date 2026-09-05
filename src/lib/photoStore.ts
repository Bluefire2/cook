import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

export const photoStore = {
  async add(blob: Blob): Promise<string> {
    const id = crypto.randomUUID();
    await db.photos.add({ id, blob, createdAt: Date.now() });
    return id;
  },

  async getBlob(id: string): Promise<Blob | undefined> {
    const photo = await db.photos.get(id);
    return photo?.blob;
  },

  async remove(id: string): Promise<void> {
    await db.photos.delete(id);
  },

  /**
   * Deletes photo blobs nothing references. Store-on-send is the primary leak
   * fix; the age window only avoids deleting a blob another tab wrote
   * milliseconds ago and has not yet referenced from a message.
   */
  async sweepUnreferenced(olderThanMs = 5 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    return db.transaction('rw', [db.recipes, db.chatMessages, db.photos], async () => {
      const referenced = new Set<string>();
      for (const recipe of await db.recipes.toArray()) {
        if (recipe.photoId) referenced.add(recipe.photoId);
      }
      for (const message of await db.chatMessages.toArray()) {
        for (const id of message.photoIds ?? []) referenced.add(id);
      }
      const toDelete = (await db.photos.toArray())
        .filter((p) => !referenced.has(p.id) && p.createdAt <= cutoff)
        .map((p) => p.id);
      await db.photos.bulkDelete(toDelete);
      return toDelete.length;
    });
  },
};

/**
 * Object URL for a blob, revoked once it is replaced or the caller unmounts.
 * An unrevoked URL pins its blob until the document goes away, and here that
 * document is an installed PWA that stays alive for weeks. The Library mints
 * one per photo card, so without this every trip into a recipe and back left
 * another whole set of them behind: measured at 40 recipes, five round trips
 * stranded 165 blobs.
 */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return url;
}

/**
 * Reactive object URL for a stored photo. Returns `undefined` while loading
 * or when there is no photo.
 */
export function usePhotoUrl(id: string | undefined): string | undefined {
  const blob = useLiveQuery(
    async () => (id ? photoStore.getBlob(id) : undefined),
    [id],
  );
  return useObjectUrl(blob);
}
