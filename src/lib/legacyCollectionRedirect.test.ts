import { describe, expect, it } from 'vitest';
import { importHref, libraryHref, newRecipeHref } from './collectionHref';
import { legacyCollectionRedirectTarget } from './legacyCollectionRedirect';

const SAMPLE_COLLECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('legacyCollectionRedirectTarget', () => {
  describe('libraryHref', () => {
    it('returns null when c is absent', () => {
      expect(legacyCollectionRedirectTarget(null, libraryHref)).toBe(null);
    });

    it('returns / when c is empty', () => {
      expect(legacyCollectionRedirectTarget('', libraryHref)).toBe('/');
    });

    it('returns the collection path for a normal id', () => {
      expect(legacyCollectionRedirectTarget(SAMPLE_COLLECTION_ID, libraryHref)).toBe(
        `/collections/${SAMPLE_COLLECTION_ID}`,
      );
    });

    it('encodes the id', () => {
      expect(legacyCollectionRedirectTarget('a/b', libraryHref)).toBe(
        '/collections/a%2Fb',
      );
    });
  });

  describe('importHref', () => {
    it('returns null when c is absent', () => {
      expect(legacyCollectionRedirectTarget(null, importHref)).toBe(null);
    });

    it('returns /import when c is empty', () => {
      expect(legacyCollectionRedirectTarget('', importHref)).toBe('/import');
    });

    it('returns the nested import path for a normal id', () => {
      expect(legacyCollectionRedirectTarget(SAMPLE_COLLECTION_ID, importHref)).toBe(
        `/collections/${SAMPLE_COLLECTION_ID}/import`,
      );
    });

    it('encodes the id', () => {
      expect(legacyCollectionRedirectTarget('a/b', importHref)).toBe(
        '/collections/a%2Fb/import',
      );
    });
  });

  describe('newRecipeHref', () => {
    it('returns null when c is absent', () => {
      expect(legacyCollectionRedirectTarget(null, newRecipeHref)).toBe(null);
    });

    it('returns /recipe/new when c is empty', () => {
      expect(legacyCollectionRedirectTarget('', newRecipeHref)).toBe('/recipe/new');
    });

    it('returns the nested new-recipe path for a normal id', () => {
      expect(legacyCollectionRedirectTarget(SAMPLE_COLLECTION_ID, newRecipeHref)).toBe(
        `/collections/${SAMPLE_COLLECTION_ID}/recipe/new`,
      );
    });

    it('encodes the id', () => {
      expect(legacyCollectionRedirectTarget('a/b', newRecipeHref)).toBe(
        '/collections/a%2Fb/recipe/new',
      );
    });
  });
});
