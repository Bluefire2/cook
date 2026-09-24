import { afterEach, describe, expect, it } from 'vitest';
import {
  addPendingBlob,
  clearLibrary,
  countOwnedNamedCollections,
  getGrantCount,
  getRecipe,
  getSnapshot,
  isSharedRecipe,
  mergeSharedFromPull,
  replaceFromPull,
  replaceFromPullWithShared,
  setGrantCount,
  subscribe,
  upsertCollection,
  upsertRecipe,
} from './libraryMemory';
import type { Collection, Recipe } from './types';

function recipe(id: string, title: string): Recipe {
  return {
    id,
    title,
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  clearLibrary();
});

describe('mergeSharedFromPull', () => {
  it('adds a shared recipe and refuses to overwrite an owned id', () => {
    const own = recipe('own-1', 'Mine');
    replaceFromPull({
      recipes: new Map([[own.id, own]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });
    const collision = recipe('own-1', 'Theirs');
    const shared = recipe('shared-1', 'Shared soup');
    mergeSharedFromPull({
      recipes: new Map([
        [collision.id, collision],
        [shared.id, shared],
      ]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [collision.id, { kind: 'shared', ownerSub: 'owner' }],
        [shared.id, { kind: 'shared', ownerSub: 'owner' }],
      ]),
      collectionOrigins: new Map(),
    });
    expect(getRecipe('own-1')?.title).toBe('Mine');
    expect(isSharedRecipe('own-1')).toBe(false);
    expect(getRecipe('shared-1')?.title).toBe('Shared soup');
    expect(isSharedRecipe('shared-1')).toBe(true);
  });

  it('marks a locally created recipe as owned', () => {
    upsertRecipe(recipe('new-1', 'Fresh'));
    expect(isSharedRecipe('new-1')).toBe(false);
  });
});

describe('replaceFromPullWithShared', () => {
  it('publishes one complete owned-precedence snapshot and preserves local caches', () => {
    addPendingBlob('pending-photo', new Blob(['pending']));
    setGrantCount('owned-collection', 2);
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });

    replaceFromPullWithShared(
      {
        recipes: new Map([['collision', recipe('collision', 'Mine')]]),
        collections: new Map([
          ['owned-collection', collection('owned-collection', 'Mine')],
        ]),
        chat: new Map(),
        cook: new Map(),
        remotePhotoIds: new Set(['owned-photo']),
      },
      {
        recipes: new Map([
          ['collision', recipe('collision', 'Theirs')],
          ['shared-recipe', recipe('shared-recipe', 'Shared')],
        ]),
        collections: new Map([
          ['shared-collection', collection('shared-collection', 'Shared')],
        ]),
        remotePhotoIds: new Set(['shared-photo']),
        recipeOrigins: new Map([
          ['collision', { kind: 'shared', ownerSub: 'owner' }],
          ['shared-recipe', { kind: 'shared', ownerSub: 'owner' }],
        ]),
        collectionOrigins: new Map([
          ['shared-collection', { kind: 'shared', ownerSub: 'owner' }],
        ]),
      },
    );
    unsubscribe();

    const snapshot = getSnapshot();
    expect(calls).toBe(1);
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.recipes.get('collision')?.title).toBe('Mine');
    expect(snapshot.recipeOrigins.get('collision')).toEqual({ kind: 'own' });
    expect(snapshot.recipeOrigins.get('shared-recipe')).toEqual({
      kind: 'shared',
      ownerSub: 'owner',
    });
    expect(snapshot.collectionOrigins.get('owned-collection')).toEqual({
      kind: 'own',
    });
    expect(snapshot.collectionOrigins.get('shared-collection')).toEqual({
      kind: 'shared',
      ownerSub: 'owner',
    });
    expect([...snapshot.remotePhotoIds]).toEqual(['owned-photo', 'shared-photo']);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
    expect(snapshot.grantCounts.get('owned-collection')).toBe(2);
  });
});

function collection(id: string, name: string): Collection {
  return {
    id,
    name,
    recipeIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('setGrantCount', () => {
  it('distinguishes an unknown count from known zero and positive counts', () => {
    expect(getGrantCount('col-1')).toBeUndefined();
    setGrantCount('col-1', 0);
    expect(getGrantCount('col-1')).toBe(0);
    setGrantCount('col-1', 2);
    expect(getGrantCount('col-1')).toBe(2);
  });

  it('does not notify subscribers when the count is unchanged', () => {
    let calls = 0;
    const unsub = subscribe(() => {
      calls += 1;
    });
    setGrantCount('col-1', 2);
    expect(calls).toBe(1);
    setGrantCount('col-1', 2);
    expect(calls).toBe(1);
    setGrantCount('col-1', 3);
    expect(calls).toBe(2);
    unsub();
  });
});

describe('countOwnedNamedCollections', () => {
  it('counts only owned and missing-origin collections', () => {
    replaceFromPull({
      recipes: new Map(),
      collections: new Map([
        ['owned-a', collection('owned-a', 'A')],
        ['owned-b', collection('owned-b', 'B')],
      ]),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });
    expect(countOwnedNamedCollections()).toBe(2);

    mergeSharedFromPull({
      recipes: new Map(),
      collections: new Map([['shared-1', collection('shared-1', 'Shared')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([
        ['shared-1', { kind: 'shared', ownerSub: 'alice' }],
      ]),
    });
    expect(countOwnedNamedCollections()).toBe(2);

    upsertCollection(collection('owned-c', 'C'));
    expect(countOwnedNamedCollections()).toBe(3);
  });
});
