import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  countOwnedNamedCollections,
  getGrantCount,
  getRecipe,
  isSharedRecipe,
  mergeSharedFromPull,
  replaceFromPull,
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
