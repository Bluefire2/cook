import type { ItemOrigin, SharedPullSnapshot } from './libraryMemory';
import { getSnapshot, replaceFromPullWithShared } from './libraryMemory';
import type { Collection, Recipe } from './types';

/**
 * Test setup: publishes the current library plus `shared` through the real
 * atomic publisher. Rows already present win over incoming shared rows.
 */
export function installSharedRows(shared: SharedPullSnapshot): void {
  const current = getSnapshot();
  const ownedRecipes = new Map<string, Recipe>();
  const ownedCollections = new Map<string, Collection>();
  const merged: SharedPullSnapshot = {
    recipes: new Map(),
    collections: new Map(),
    remotePhotoIds: new Set(shared.remotePhotoIds),
    recipeOrigins: new Map(),
    collectionOrigins: new Map(),
  };
  for (const [id, recipe] of current.recipes) {
    const origin = current.recipeOrigins.get(id);
    if (origin?.kind === 'shared') {
      merged.recipes.set(id, recipe);
      merged.recipeOrigins.set(id, origin);
    } else {
      ownedRecipes.set(id, recipe);
    }
  }
  for (const [id, collection] of current.collections) {
    const origin = current.collectionOrigins.get(id);
    if (origin?.kind === 'shared') {
      merged.collections.set(id, collection);
      merged.collectionOrigins.set(id, origin);
    } else {
      ownedCollections.set(id, collection);
    }
  }
  const addIfAbsent = <T>(
    rows: Map<string, T>,
    origins: Map<string, ItemOrigin>,
    incoming: Map<string, T>,
    incomingOrigins: Map<string, ItemOrigin>,
    taken: (id: string) => boolean,
  ) => {
    for (const [id, row] of incoming) {
      if (taken(id) || rows.has(id)) {
        continue;
      }
      rows.set(id, row);
      const origin = incomingOrigins.get(id);
      if (origin) {
        origins.set(id, origin);
      }
    }
  };
  addIfAbsent(merged.recipes, merged.recipeOrigins, shared.recipes, shared.recipeOrigins, (id) =>
    ownedRecipes.has(id),
  );
  addIfAbsent(
    merged.collections,
    merged.collectionOrigins,
    shared.collections,
    shared.collectionOrigins,
    (id) => ownedCollections.has(id),
  );
  replaceFromPullWithShared(
    {
      recipes: ownedRecipes,
      collections: ownedCollections,
      chat: new Map(current.chat),
      cook: new Map(current.cook),
      cookLogs: new Map(current.cookLogs),
      remotePhotoIds: new Set(current.remotePhotoIds),
      chatParentOrigins: current.chatParentOrigins,
      cookParentOrigins: current.cookParentOrigins,
    },
    merged,
  );
}
