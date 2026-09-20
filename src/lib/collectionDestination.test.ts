import { describe, expect, it } from 'vitest';
import { resolveCollectionDestination } from './collectionDestination';
import type { Collection } from './types';

const collection: Collection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Dinners', recipeIds: [], createdAt: 1, updatedAt: 1,
};

describe('resolveCollectionDestination', () => {
  it('waits for loading even with a requested folder or previous selection', () => {
    expect(resolveCollectionDestination(undefined, collection.id)).toEqual({ kind: 'loading' });
    expect(resolveCollectionDestination(undefined, undefined, null)).toEqual({ kind: 'loading' });
  });
  it('asks from the top-level view, including an empty library', () => {
    expect(resolveCollectionDestination([], undefined)).toEqual({ kind: 'choose' });
    expect(resolveCollectionDestination([collection], undefined)).toEqual({ kind: 'choose' });
  });
  it('saves directly into a live starting folder', () => {
    expect(resolveCollectionDestination([collection], collection.id)).toEqual({
      kind: 'save', collectionId: collection.id,
    });
  });
  it('asks again for unknown or deleted folders', () => {
    expect(resolveCollectionDestination([], collection.id)).toEqual({ kind: 'choose' });
    expect(resolveCollectionDestination([collection], 'missing')).toEqual({ kind: 'choose' });
  });
  it('retains a live batch selection, overriding its starting folder', () => {
    expect(resolveCollectionDestination([collection], 'other', collection.id)).toEqual({
      kind: 'save', collectionId: collection.id,
    });
  });
  it('retains an explicit unfiled selection', () => {
    expect(resolveCollectionDestination([collection], collection.id, null)).toEqual({
      kind: 'save', collectionId: undefined,
    });
  });
  it('asks again when a selected batch folder disappears, without falling back', () => {
    expect(resolveCollectionDestination([collection], collection.id, 'deleted')).toEqual({ kind: 'choose' });
  });
});
