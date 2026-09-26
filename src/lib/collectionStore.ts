import { useMemo, useSyncExternalStore } from 'react';
import {
  MAX_COLLECTION_NAME_LENGTH,
  MAX_NAMED_COLLECTIONS,
  compactCollection,
  compactCollectionName,
} from './compactCollection';
import { moveRecipe, wouldExceedRecipeIdCap } from './collectionMembership';
import {
  countOwnedNamedCollections,
  getCollection,
  getSnapshot,
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  removeCollectionLocal,
  setGrantCount,
  subscribe,
  upsertCollection,
} from './libraryMemory';
import {
  addCollectionGrant,
  listCollectionGrants,
  pushOps,
  revokeCollectionGrant,
  type CollectionGrant,
  type RemoteResult,
} from './remote';
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
    const grants = result.grants ?? [];
    setGrantCount(id, grants.length);
    return grants;
  },

  async addGrant(id: string, email: string): Promise<CollectionGrant> {
    rejectShared(id);
    const result = await addCollectionGrant(id, email);
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
