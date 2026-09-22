import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  getRecipe,
  isSharedRecipe,
  mergeSharedFromPull,
  replaceFromPull,
  upsertRecipe,
} from './libraryMemory';
import type { Recipe } from './types';

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
