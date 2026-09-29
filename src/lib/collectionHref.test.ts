import { describe, expect, it } from 'vitest';
import { importHref, libraryHref, newRecipeHref } from './collectionHref';

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
