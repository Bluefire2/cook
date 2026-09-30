import type { SyncStatusKind } from './syncEngine';

function collectionPath(collectionId: string): string {
  return `/collections/${encodeURIComponent(collectionId)}`;
}

export type MissingCollectionAction = {
  /** `replace` target once a successful sync has shown the id is gone. */
  redirectTo: '/' | null;
  /** Close rename, delete, leave, and share. The URL itself did not change. */
  resetCollectionSheets: boolean;
};

/**
 * What Library should do when `/collections/:id` is not in the loaded list.
 * A slow or failed pull must not send a still-valid collection home: that
 * requires sync status `idle` after a success (`lastSyncedAt` set). An owned
 * delete removes the collection locally before the server answers, so both
 * actions wait until that request settles.
 */
export function missingCollectionAction(input: {
  collectionId: string | undefined;
  /** Undefined until the library has loaded. An empty list has loaded. */
  collectionIds: readonly string[] | undefined;
  syncStatus: SyncStatusKind;
  lastSyncedAt: number | null;
  deleteInFlight: boolean;
}): MissingCollectionAction {
  const none: MissingCollectionAction = {
    redirectTo: null,
    resetCollectionSheets: false,
  };
  if (input.collectionId === undefined || input.collectionId === '') return none;
  if (input.collectionIds === undefined) return none;
  if (input.collectionIds.includes(input.collectionId)) return none;
  if (input.deleteInFlight) return none;
  const confirmed = input.syncStatus === 'idle' && input.lastSyncedAt !== null;
  return {
    redirectTo: confirmed ? '/' : null,
    resetCollectionSheets: true,
  };
}

export function libraryHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/';
  }
  return collectionPath(collectionId);
}

export function importHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/import';
  }
  return `${collectionPath(collectionId)}/import`;
}

export function newRecipeHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/recipe/new';
  }
  return `${collectionPath(collectionId)}/recipe/new`;
}
