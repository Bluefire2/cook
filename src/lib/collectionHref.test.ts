import { describe, expect, it } from 'vitest';
import {
  importHref,
  libraryHref,
  missingCollectionAction,
  newRecipeHref,
} from './collectionHref';

const SAMPLE_COLLECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('libraryHref', () => {
  it('returns / when the id is missing or empty', () => {
    expect(libraryHref(undefined)).toBe('/');
    expect(libraryHref('')).toBe('/');
  });

  it('uses the collection path for a uuid id', () => {
    expect(libraryHref(SAMPLE_COLLECTION_ID)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}`,
    );
  });

  it('encodes the id into a collection path', () => {
    expect(libraryHref('a/b')).toBe('/collections/a%2Fb');
  });
});

describe('importHref', () => {
  it('returns /import when the id is missing or empty', () => {
    expect(importHref(undefined)).toBe('/import');
    expect(importHref('')).toBe('/import');
  });

  it('nests import under the collection path', () => {
    expect(importHref(SAMPLE_COLLECTION_ID)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}/import`,
    );
    expect(importHref('a/b')).toBe('/collections/a%2Fb/import');
  });
});

describe('missingCollectionAction', () => {
  const gone = {
    collectionId: 'gone',
    collectionIds: ['kept'] as readonly string[] | undefined,
    syncStatus: 'idle' as const,
    lastSyncedAt: 1 as number | null,
    deleteInFlight: false,
  };

  it('replace-navigates once a successful sync has loaded a library without that id', () => {
    expect(missingCollectionAction(gone)).toEqual({
      redirectTo: '/',
      resetCollectionSheets: true,
    });
    expect(missingCollectionAction({ ...gone, collectionIds: [] })).toEqual({
      redirectTo: '/',
      resetCollectionSheets: true,
    });
  });

  it('does nothing on the default library or when the id is still listed', () => {
    expect(missingCollectionAction({ ...gone, collectionId: undefined })).toEqual({
      redirectTo: null,
      resetCollectionSheets: false,
    });
    expect(missingCollectionAction({ ...gone, collectionId: '' })).toEqual({
      redirectTo: null,
      resetCollectionSheets: false,
    });
    expect(missingCollectionAction({ ...gone, collectionIds: ['gone', 'kept'] })).toEqual({
      redirectTo: null,
      resetCollectionSheets: false,
    });
  });

  it('waits until the library has loaded', () => {
    expect(missingCollectionAction({ ...gone, collectionIds: undefined })).toEqual({
      redirectTo: null,
      resetCollectionSheets: false,
    });
  });

  it('does not redirect on a slow, failed, signed-out, or not-yet-successful sync', () => {
    for (const syncStatus of ['loading', 'error', 'signedOut'] as const) {
      const action = missingCollectionAction({ ...gone, syncStatus });
      expect(action.redirectTo).toBe(null);
      expect(action.resetCollectionSheets).toBe(true);
    }
    const notYet = missingCollectionAction({ ...gone, lastSyncedAt: null });
    expect(notYet.redirectTo).toBe(null);
    expect(notYet.resetCollectionSheets).toBe(true);
  });

  it('holds the redirect and the sheets while an owned delete is in flight', () => {
    expect(missingCollectionAction({ ...gone, deleteInFlight: true })).toEqual({
      redirectTo: null,
      resetCollectionSheets: false,
    });
  });
});

describe('newRecipeHref', () => {
  it('returns /recipe/new when the id is missing or empty', () => {
    expect(newRecipeHref(undefined)).toBe('/recipe/new');
    expect(newRecipeHref('')).toBe('/recipe/new');
  });

  it('nests new recipe under the collection path', () => {
    expect(newRecipeHref(SAMPLE_COLLECTION_ID)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}/recipe/new`,
    );
    expect(newRecipeHref('a/b')).toBe('/collections/a%2Fb/recipe/new');
  });
});
