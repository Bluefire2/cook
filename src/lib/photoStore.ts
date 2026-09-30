import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  addPendingBlob,
  cachePhotoBlob,
  dropPhoto,
  getPendingBlob,
  getSnapshot,
  markPhotoRemote,
  photoOwnerSub,
  subscribe,
} from './libraryMemory';
import { withLocalWrite } from './localWrite';
import { fetchPhotoBlob, pushOps } from './remote';

const ensureLocalInFlight = new Map<string, Promise<void>>();

async function ensureLocalOnce(id: string): Promise<void> {
  if (getPendingBlob(id)) {
    return;
  }
  const blob = await fetchPhotoBlob(id, photoOwnerSub(id));
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

  /** True once the server holds this photo's bytes. */
  isRemote(id: string): boolean {
    return getSnapshot().remotePhotoIds.has(id);
  },

  async remove(id: string): Promise<void> {
    const at = Date.now();
    const remote = getSnapshot().remotePhotoIds.has(id);
    const pending = getPendingBlob(id);
    await withLocalWrite(async () => {
      dropPhoto(id);
      const result = await pushOps([{ kind: 'photo.delete', payload: { id, updatedAt: at } }]);
      if (result !== 'ok') {
        // A 401 already cleared the library. Putting the id back would
        // repopulate a signed-out session. Any other failure still has the
        // photo on the server, and the pull that overlapped this write was
        // discarded, so it cannot put the id back itself.
        if (result !== 'signedOut' && remote) {
          if (pending) {
            cachePhotoBlob(id, pending);
          } else {
            markPhotoRemote(id);
          }
        }
        return { value: undefined, reconcile: false };
      }
      return { value: undefined, reconcile: true };
    });
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
