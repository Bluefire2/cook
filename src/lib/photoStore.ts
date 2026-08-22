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
