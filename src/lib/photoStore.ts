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
 * Reactive object URL for a stored photo. Returns `undefined` while loading
 * or when there is no photo. Note: object URLs are intentionally not revoked
 * eagerly; they live for the page session, which is fine at this app's scale.
 */
export function usePhotoUrl(id: string | undefined): string | undefined {
  return useLiveQuery(async () => {
    if (!id) return undefined;
    const blob = await photoStore.getBlob(id);
    return blob ? URL.createObjectURL(blob) : undefined;
  }, [id]);
}
