import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  addPendingBlob,
  cachePhotoBlob,
  dropPhoto,
  getPendingBlob,
  getSnapshot,
  subscribe,
} from './libraryMemory';
import { fetchPhotoBlob, pushOps } from './remote';

const ensureLocalInFlight = new Map<string, Promise<void>>();

async function ensureLocalOnce(id: string): Promise<void> {
  if (getPendingBlob(id)) {
    return;
  }
  const blob = await fetchPhotoBlob(id);
  if (blob === 'signedOut' || blob === null) {
    return;
  }
  cachePhotoBlob(id, blob);
}

export const photoStore = {
  async add(blob: Blob): Promise<string> {
    const id = crypto.randomUUID();
    addPendingBlob(id, blob);
    return id;
  },

  async getBlob(id: string): Promise<Blob | undefined> {
    return getPendingBlob(id);
  },

  ensureLocal(id: string): Promise<void> {
    let pending = ensureLocalInFlight.get(id);
    if (!pending) {
      pending = ensureLocalOnce(id).finally(() => {
        ensureLocalInFlight.delete(id);
      });
      ensureLocalInFlight.set(id, pending);
    }
    return pending;
  },

  /**
   * Forget a blob that was staged but never attached to a saved recipe.
   * Local only: nothing was uploaded yet, so there is nothing to tombstone.
   */
  discardLocal(id: string): void {
    dropPhoto(id);
  },

  async remove(id: string): Promise<void> {
    const at = Date.now();
    dropPhoto(id);
    await pushOps([{ kind: 'photo.delete', payload: { id, updatedAt: at } }]);
  },
};

/**
 * Object URL for a blob, revoked once it is replaced or the caller unmounts.
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
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  const blob = id ? snap.pendingBlobs.get(id) : undefined;
  useEffect(() => {
    if (id) void photoStore.ensureLocal(id);
  }, [id]);
  return useObjectUrl(blob);
}
