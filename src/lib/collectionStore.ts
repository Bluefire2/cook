import { useMemo, useSyncExternalStore } from 'react';
import {
  MAX_COLLECTION_NAME_LENGTH,
  MAX_NAMED_COLLECTIONS,
  compactCollection,
  compactCollectionName,
} from './compactCollection';
import { moveRecipe, wouldExceedRecipeIdCap } from './collectionMembership';
import {
  beginLocalWrite,
  collectionAccess,
  countOwnedNamedCollections,
  endLocalWrite,
  getCollectionOrigin,
  getCollection,
  getSnapshot,
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  removeCollectionLocal,
  subscribe,
  upsertCollection,
  type LibraryAccess,
} from './libraryMemory';
import {
  addCollectionGrant,
  leaveSharedCollection,
  listCollectionGrants,
  pushOps,
  revokeCollectionGrant,
  setCollectionGrantRole,
  type CollectionGrant,
  type GrantRole,
  type LeaveSharedResult,
  type RemoteResult,
} from './remote';
import { pullAfterLocalWrite } from './syncEngine';
import type { Collection } from './types';

function rejectShared(id: string): void {
  if (isSharedCollection(id)) {
    throw new Error('This shared collection is view-only.');
  }
}

export function collectionPushErrorMessage(result: RemoteResult, created = false): string {
  if (result === 'signedOut') {
    return 'Please sign in again — your session expired.';
  }
  if (created && result === 'cap') {
    return `You can have up to ${MAX_NAMED_COLLECTIONS} collections.`;
  }
  return "Couldn't save the collection.";
}

function saveError(result: RemoteResult, created = false): Error {
  return new Error(collectionPushErrorMessage(result, created));
}

async function pushCollection(
  next: Collection,
  previous: Collection | undefined,
  created = false,
): Promise<void> {
  upsertCollection(next);
  try {
    const result = await pushOps([{ kind: 'collection.put', payload: next }]);
    if (result !== 'ok') {
      throw saveError(result, created);
    }
  } catch (err) {
    if (previous) {
      upsertCollection(previous);
    } else {
      removeCollectionLocal(next.id);
    }
    throw err;
  }
}

export const collectionStore = {
  list(): Collection[] {
    return listCollections();
  },

  /** True for a collection that arrived through an incoming share (view-only). */
  isShared(id: string): boolean {
    return isSharedCollection(id);
  },

  /** `editor` when a shared collection's recipes may be edited here. */
  access(id: string): LibraryAccess | undefined {
    return collectionAccess(id);
  },

  /** Email of whoever shared this collection with you, when known. */
  sharedBy(id: string): string | undefined {
    const origin = getCollectionOrigin(id);
    return origin?.kind === 'shared' ? origin.ownerEmail : undefined;
  },

  get(id: string): Collection | undefined {
    return getCollection(id);
  },

  async create(name: string): Promise<Collection> {
    const trimmed = compactCollectionName(name);
    if (trimmed === undefined) {
      throw new Error(
        name.trim() === ''
          ? 'Name this collection.'
          : `Keep the name under ${MAX_COLLECTION_NAME_LENGTH} characters.`,
      );
    }
    if (countOwnedNamedCollections() >= MAX_NAMED_COLLECTIONS) {
      throw new Error(`You can have up to ${MAX_NAMED_COLLECTIONS} collections.`);
    }
    const now = Date.now();
    const collection = compactCollection({
      id: crypto.randomUUID(),
      name: trimmed,
      recipeIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await pushCollection(collection, undefined, true);
    return collection;
  },

  async rename(id: string, name: string): Promise<void> {
    rejectShared(id);
    const existing = getCollection(id);
    if (!existing) {
      throw new Error('Collection not found.');
    }
    const trimmed = compactCollectionName(name);
    if (trimmed === undefined) {
      throw new Error(
        name.trim() === ''
          ? 'Name this collection.'
          : `Keep the name under ${MAX_COLLECTION_NAME_LENGTH} characters.`,
      );
    }
    await pushCollection(
      compactCollection({ ...existing, name: trimmed, updatedAt: Date.now() }),
      existing,
    );
  },

  async remove(id: string): Promise<void> {
    rejectShared(id);
    const previous = getCollection(id);
    const at = Date.now();
    removeCollectionLocal(id);
    const result = await pushOps([{ kind: 'collection.delete', payload: { id, updatedAt: at } }]);
    if (result !== 'ok') {
      if (previous) {
        upsertCollection(previous);
      }
      throw saveError(result);
    }
  },

  async listGrants(id: string): Promise<CollectionGrant[]> {
    rejectShared(id);
    const result = await listCollectionGrants(id);
    if (result.kind === 'signedOut') {
      throw new Error('Please sign in again — your session expired.');
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
    return result.grants ?? [];
  },

  async addGrant(
    id: string,
    email: string,
    role: GrantRole = 'viewer',
  ): Promise<CollectionGrant> {
    rejectShared(id);
    const result = await addCollectionGrant(id, email, role);
    if (result.kind === 'signedOut') {
      throw new Error('Please sign in again — your session expired.');
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
    if (!result.grant) {
      throw new Error("Couldn't update sharing.");
    }
    return result.grant;
  },

  async setGrantRole(id: string, sub: string, role: GrantRole): Promise<void> {
    rejectShared(id);
    const result = await setCollectionGrantRole(id, sub, role);
    if (result.kind === 'signedOut') {
      throw new Error('Please sign in again — your session expired.');
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
  },

  async revokeGrant(id: string, sub: string): Promise<void> {
    rejectShared(id);
    const result = await revokeCollectionGrant(id, sub);
    if (result.kind === 'signedOut') {
      throw new Error('Please sign in again — your session expired.');
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
  },

  /** Only for a collection shared with you. Owned collections have no Leave control. */
  async leave(id: string): Promise<void> {
    const origin = getCollectionOrigin(id);
    if (origin?.kind !== 'shared') {
      throw new Error('This collection is not shared with you.');
    }
    // A pull that started before this tombstone can otherwise publish the
    // collection back onto the screen after we return. Hold the library
    // the same way recipe delete does, then read the server instead of
    // trusting that a concurrent pull already saw the tombstone.
    const writeEpoch = beginLocalWrite();
    let result: LeaveSharedResult;
    try {
      result = await leaveSharedCollection(origin.ownerSub, id);
    } finally {
      endLocalWrite();
    }
    if (result.kind === 'signedOut') {
      throw new Error('Please sign in again — your session expired.');
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
    // Leave succeeded (or the grant was already gone). Drop it locally right
    // away so the screen doesn't flash it back before the pull below lands.
    removeCollectionLocal(id);
    const outcome = await pullAfterLocalWrite(writeEpoch);
    if (outcome === 'signedOut') {
      throw new Error('Please sign in again — your session expired.');
    }
    if (outcome !== 'ok') {
      throw new Error("Couldn't refresh after leaving.");
    }
  },

  async moveRecipe(recipeId: string, dest: 'default' | string): Promise<void> {
    if (isSharedRecipe(recipeId) || (dest !== 'default' && isSharedCollection(dest))) {
      throw new Error('This shared collection is view-only.');
    }
    if (dest !== 'default') {
      const destCollection = getCollection(dest);
      if (!destCollection) {
        throw new Error('Collection not found.');
      }
      if (
        !destCollection.recipeIds.includes(recipeId) &&
        wouldExceedRecipeIdCap([...destCollection.recipeIds, recipeId])
      ) {
        throw new Error('This collection is full.');
      }
    }
    const now = Date.now();
    const current = listCollections();
    const changed = moveRecipe(current, recipeId, dest, now).map(compactCollection);
    if (changed.length === 0) {
      return;
    }
    const previous = changed
      .map((next) => current.find((c) => c.id === next.id))
      .filter((c): c is Collection => c !== undefined);
    for (const next of changed) {
      upsertCollection(next);
    }
    try {
      const result = await pushOps(
        changed.map((payload) => ({ kind: 'collection.put' as const, payload })),
      );
      if (result !== 'ok') {
        throw saveError(result);
      }
    } catch (err) {
      for (const collection of previous) {
        upsertCollection(collection);
      }
      throw err;
    }
  },
};

export function useCollections(): Collection[] | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => {
    if (!snap.loaded) {
      return undefined;
    }
    return listCollections();
  }, [snap]);
}

export function libraryHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/';
  }
  return `/?c=${encodeURIComponent(collectionId)}`;
}
