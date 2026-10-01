import { useMemo } from 'react';
import { t } from '../i18n';
import {
  MAX_COLLECTION_NAME_LENGTH,
  MAX_COLLECTION_RECIPE_IDS,
  MAX_NAMED_COLLECTIONS,
  compactCollection,
  compactCollectionName,
} from './compactCollection';
import {
  moveRecipe,
  moveRecipes,
  winningMembership,
  wouldExceedRecipeIdCap,
} from './collectionMembership';
import {
  collectionAccess,
  countOwnedNamedCollections,
  getCollectionOrigin,
  getCollection,
  getRecipe,
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  removeCollectionLocal,
  sortCollections,
  upsertCollection,
  type LibraryAccess,
} from './libraryMemory';
import { useLibrarySlice } from './useLibrary';
import {
  addCollectionGrant,
  createCollectionLink,
  leaveSharedCollection,
  listCollectionGrants,
  listCollectionLinks,
  pushOps,
  revokeCollectionGrant,
  revokeCollectionLink,
  setCollectionGrantRole,
  type CollectionGrant,
  type CollectionLink,
  type CollectionLinkHttpResult,
  type CollectionLinksBody,
  type GrantRole,
  type RemoteResult,
} from './remote';
import { withLocalWrite } from './localWrite';
import { SessionExpiredError } from './sessionExpired';
import type { Collection } from './types';

function rejectShared(id: string): void {
  if (isSharedCollection(id)) {
    throw new Error(t('error.sharedViewOnly'));
  }
}

export function collectionPushErrorMessage(result: RemoteResult, created = false): string {
  if (result === 'signedOut') {
    return t('error.sessionExpired');
  }
  if (created && result === 'cap') {
    return t('error.collectionCap', { max: MAX_NAMED_COLLECTIONS });
  }
  return t('error.collectionSave');
}

function saveError(result: RemoteResult, created = false): Error {
  return result === 'signedOut'
    ? new SessionExpiredError()
    : new Error(collectionPushErrorMessage(result, created));
}

/** A link the share sheet just minted: the one-time URL and its sha256 id. */
export type MintedLink = { url: string; id: string };

/**
 * The shown-once URL stays visible only while its link is in the live list.
 * Revoking it, or a refreshed list without it, hides the URL.
 */
export function visibleMintedUrl(
  minted: MintedLink | null,
  links: readonly CollectionLink[] | undefined,
): string | null {
  if (minted === null || links === undefined) {
    return null;
  }
  return links.some((link) => link.id === minted.id) ? minted.url : null;
}

function linkResult(
  result: CollectionLinkHttpResult,
): CollectionLinksBody {
  if (result.kind === 'signedOut') {
    throw new Error(t('error.sessionExpired'));
  }
  if (result.kind === 'error') {
    throw new Error(result.message);
  }
  const body: CollectionLinksBody = { links: result.links };
  if (result.url !== undefined) {
    body.url = result.url;
  }
  if (result.id !== undefined) {
    body.id = result.id;
  }
  if (result.revokedId !== undefined) {
    body.revokedId = result.revokedId;
  }
  if (result.partial) {
    body.partial = true;
  }
  return body;
}

async function pushCollection(
  next: Collection,
  previous: Collection | undefined,
  created = false,
): Promise<void> {
  await withLocalWrite(async () => {
    upsertCollection(next);
    try {
      const result = await pushOps([{ kind: 'collection.put', payload: next }]);
      if (result !== 'ok') {
        throw saveError(result, created);
      }
      return { value: undefined, reconcile: true };
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The 401 cleared the library already; write nothing back into it.
        throw err;
      }
      if (previous) {
        upsertCollection(previous);
      } else {
        removeCollectionLocal(next.id);
      }
      return { value: undefined, reconcile: false, error: err };
    }
  });
}

export const collectionStore = {
  list(): Collection[] {
    return listCollections();
  },

  /** True for a collection that arrived through an incoming share. */
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
          ? t('error.collectionNameEmpty')
          : t('error.collectionNameLong', { max: MAX_COLLECTION_NAME_LENGTH }),
      );
    }
    if (countOwnedNamedCollections() >= MAX_NAMED_COLLECTIONS) {
      throw new Error(t('error.collectionCap', { max: MAX_NAMED_COLLECTIONS }));
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
      throw new Error(t('error.collectionNotFound'));
    }
    const trimmed = compactCollectionName(name);
    if (trimmed === undefined) {
      throw new Error(
        name.trim() === ''
          ? t('error.collectionNameEmpty')
          : t('error.collectionNameLong', { max: MAX_COLLECTION_NAME_LENGTH }),
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
    await withLocalWrite(async () => {
      removeCollectionLocal(id);
      const result = await pushOps([{ kind: 'collection.delete', payload: { id, updatedAt: at } }]);
      if (result !== 'ok') {
        // After a 401 the library is already cleared; write nothing back into it.
        if (previous && result !== 'signedOut') {
          upsertCollection(previous);
        }
        return {
          value: undefined,
          reconcile: false,
          reread: result === 'signedOut' ? 'no' : undefined,
          error: saveError(result),
        };
      }
      return { value: undefined, reconcile: true };
    });
  },

  async listGrants(id: string): Promise<CollectionGrant[]> {
    rejectShared(id);
    const result = await listCollectionGrants(id);
    if (result.kind === 'signedOut') {
      throw new Error(t('error.sessionExpired'));
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
      throw new Error(t('error.sessionExpired'));
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
    if (!result.grant) {
      throw new Error(t('error.sharingUpdate'));
    }
    return result.grant;
  },

  async setGrantRole(id: string, sub: string, role: GrantRole): Promise<void> {
    rejectShared(id);
    const result = await setCollectionGrantRole(id, sub, role);
    if (result.kind === 'signedOut') {
      throw new Error(t('error.sessionExpired'));
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
  },

  async revokeGrant(id: string, sub: string): Promise<void> {
    rejectShared(id);
    const result = await revokeCollectionGrant(id, sub);
    if (result.kind === 'signedOut') {
      throw new Error(t('error.sessionExpired'));
    }
    if (result.kind === 'error') {
      throw new Error(result.message);
    }
  },

  /** Only for a collection shared with you. Owned collections have no Leave control. */
  async leave(id: string): Promise<void> {
    const origin = getCollectionOrigin(id);
    if (origin?.kind !== 'shared') {
      throw new Error(t('error.notSharedWithYou'));
    }
    // A pull that started before this tombstone can otherwise publish the
    // collection back onto the screen after we return. Hold the library
    // the same way recipe delete does, then read the server instead of
    // trusting that a concurrent pull already saw the tombstone.
    // Do not drop the collection locally first: that would unmount the Leave
    // sheet, so a failed refresh could not show its error. A successful pull
    // publishes state without the collection and its recipes.
    await withLocalWrite(
      async () => {
        const result = await leaveSharedCollection(origin.ownerSub, id);
        if (result.kind === 'signedOut') {
          return {
            value: undefined,
            reconcile: false,
            reread: 'no',
            error: new Error(t('error.sessionExpired')),
          };
        }
        if (result.kind === 'error') {
          return {
            value: undefined,
            reconcile: false,
            reread: 'no',
            error: new Error(result.message),
          };
        }
        return { value: undefined, reconcile: true, reread: 'always' };
      },
      {
        awaitReread: true,
        onReread(outcome) {
          if (outcome === 'signedOut') {
            throw new Error(t('error.sessionExpired'));
          }
          if (outcome !== 'ok') {
            throw new Error(t('error.leaveRefresh'));
          }
        },
      },
    );
  },

  async listLinks(id: string): Promise<CollectionLink[]> {
    rejectShared(id);
    return linkResult(await listCollectionLinks(id)).links;
  },

  /**
   * The returned `url` carries the raw token and is never shown again;
   * `linkId` is its sha256 id, so the caller can tell when it was revoked.
   * Once the server has minted, this never throws: a list read that failed
   * after the mint is retried once, and otherwise the minted row stands in.
   */
  async createLink(
    id: string,
    role: GrantRole = 'viewer',
  ): Promise<{ url: string; linkId: string; links: CollectionLink[] }> {
    rejectShared(id);
    const minted = linkResult(await createCollectionLink(id, role));
    if (minted.url === undefined || minted.id === undefined) {
      throw new Error(t('error.sharingUpdate'));
    }
    let links = minted.links;
    if (minted.partial) {
      try {
        links = linkResult(await listCollectionLinks(id)).links;
      } catch {
        // Keep the minted row; the next open of the sheet rereads the list.
      }
    }
    return { url: minted.url, linkId: minted.id, links };
  },

  /**
   * Revokes `linkId` and returns the live list to show. Once the server
   * committed the revoke this never throws: if its list read failed
   * (`partial`), the list is reread once, and otherwise `current` without the
   * revoked link stands in.
   */
  async revokeLink(
    id: string,
    linkId: string,
    current: readonly CollectionLink[] = [],
  ): Promise<CollectionLink[]> {
    rejectShared(id);
    const revoked = linkResult(await revokeCollectionLink(id, linkId));
    if (!revoked.partial) {
      return revoked.links;
    }
    const gone = revoked.revokedId ?? linkId;
    try {
      return linkResult(await listCollectionLinks(id)).links;
    } catch {
      return current.filter((link) => link.id !== gone);
    }
  },

  async moveRecipe(recipeId: string, dest: 'default' | string): Promise<void> {
    if (isSharedRecipe(recipeId) || (dest !== 'default' && isSharedCollection(dest))) {
      throw new Error(t('error.sharedViewOnly'));
    }
    if (dest !== 'default') {
      const destCollection = getCollection(dest);
      if (!destCollection) {
        throw new Error(t('error.collectionNotFound'));
      }
      if (
        !destCollection.recipeIds.includes(recipeId) &&
        wouldExceedRecipeIdCap([...destCollection.recipeIds, recipeId])
      ) {
        throw new Error(t('error.collectionFull'));
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
    await withLocalWrite(async () => {
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
        return { value: undefined, reconcile: true };
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          // The 401 cleared the library already; write nothing back into it.
          throw err;
        }
        for (const collection of previous) {
          upsertCollection(collection);
        }
        return { value: undefined, reconcile: false, error: err };
      }
    });
  },

  async moveRecipes(
    ids: readonly string[],
    dest: 'default' | string,
  ): Promise<{ moved: number }> {
    if (dest !== 'default' && isSharedCollection(dest)) {
      throw new Error(t('error.sharedViewOnly'));
    }
    if (dest !== 'default' && !getCollection(dest)) {
      throw new Error(t('error.collectionNotFound'));
    }

    const owned = listCollections().filter((c) => !isSharedCollection(c.id));
    const membership = winningMembership(owned);

    const kept: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      if (isSharedRecipe(id) || !getRecipe(id)) {
        continue;
      }
      kept.push(id);
    }

    if (kept.length === 0) {
      throw new Error(t('assistant.moveRecipesGone'));
    }

    if (dest === 'default') {
      if (wouldExceedRecipeIdCap(kept)) {
        throw new Error(t('error.collectionFull'));
      }
    } else {
      const destCollection = getCollection(dest);
      if (!destCollection) {
        throw new Error(t('error.collectionNotFound'));
      }
      const union = new Set(destCollection.recipeIds);
      for (const id of kept) {
        union.add(id);
      }
      if (union.size > MAX_COLLECTION_RECIPE_IDS) {
        throw new Error(t('error.collectionFull'));
      }
    }

    let moved = 0;
    for (const id of kept) {
      const current = membership.get(id);
      if (dest === 'default') {
        if (current !== undefined) {
          moved += 1;
        }
      } else if (current !== dest) {
        moved += 1;
      }
    }

    const now = Date.now();
    const changed = moveRecipes(owned, kept, dest, now).map(compactCollection);
    if (changed.length === 0) {
      return { moved };
    }

    const previous = changed
      .map((next) => owned.find((c) => c.id === next.id))
      .filter((c): c is Collection => c !== undefined);

    return await withLocalWrite(async () => {
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
        return { value: { moved }, reconcile: true };
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          throw err;
        }
        for (const collection of previous) {
          upsertCollection(collection);
        }
        return { value: { moved: 0 }, reconcile: false, error: err, reread: 'always' };
      }
    });
  },
};

export function useCollections(): Collection[] | undefined {
  const loaded = useLibrarySlice('loaded');
  const collections = useLibrarySlice('collections');
  // Callers filter by isShared/access beside the list, so an origin-only
  // change must hand them a new list too.
  const origins = useLibrarySlice('collectionOrigins');
  return useMemo(
    () => (loaded ? sortCollections(collections) : undefined),
    [loaded, collections, origins],
  );
}

/** True when the rows on screen came from a pull that included shared collections. */
export function useFullPull(): boolean {
  return useLibrarySlice('fullPull');
}

