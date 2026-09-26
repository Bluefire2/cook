import { describe, expect, it } from 'vitest';
import {
  canViewCollection,
  canViewRecipe,
  recipeListsPhoto,
} from './shareAuth.ts';

const share = {
  ownerSub: 'owner-1',
  collectionId: 'c1',
  grantId: 'owner-1_c1',
};

const liveCollection = {
  id: 'c1',
  name: 'Dinners',
  recipeIds: ['r1', 'r2'],
  createdAt: 1,
  updatedAt: 2,
};

const liveRecipe = {
  id: 'r1',
  title: 'Soup',
  photoId: 'p-cover',
  galleryPhotoIds: ['p-gal'],
  updatedAt: 2,
};

describe('canViewCollection', () => {
  it('rejects a missing or tombstoned collection', () => {
    expect(canViewCollection(share, undefined)).toBe(false);
    expect(
      canViewCollection(share, { ...liveCollection, deletedAt: 3 }),
    ).toBe(false);
  });

  it('accepts a live collection that matches the grant', () => {
    expect(canViewCollection(share, liveCollection)).toBe(true);
  });
});

describe('canViewRecipe', () => {
  it('rejects a collection that does not match the share', () => {
    expect(
      canViewRecipe(
        'r1',
        share,
        { ...liveCollection, id: 'different-collection' },
        liveRecipe,
      ),
    ).toBe(false);
  });

  it('rejects a recipe absent from the current collection recipe ids', () => {
    expect(canViewRecipe('r9', share, liveCollection, { id: 'r9' })).toBe(
      false,
    );
  });

  it('rejects a tombstoned collection', () => {
    expect(
      canViewRecipe(
        'r1',
        share,
        { ...liveCollection, deletedAt: 3 },
        liveRecipe,
      ),
    ).toBe(false);
  });

  it('rejects a tombstoned recipe', () => {
    expect(
      canViewRecipe('r1', share, liveCollection, { ...liveRecipe, deletedAt: 4 }),
    ).toBe(false);
  });

  it('accepts a live listed recipe', () => {
    expect(canViewRecipe('r1', share, liveCollection, liveRecipe)).toBe(true);
  });
});

describe('recipeListsPhoto', () => {
  it('accepts only cover and gallery photo references', () => {
    expect(recipeListsPhoto(liveRecipe, 'p-cover')).toBe(true);
    expect(recipeListsPhoto(liveRecipe, 'p-gal')).toBe(true);
    expect(recipeListsPhoto(liveRecipe, 'p-chat')).toBe(false);
  });
});
