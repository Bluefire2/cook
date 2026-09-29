import { describe, expect, it } from 'vitest';
import { isLibraryListPath } from './libraryRoutes';

describe('isLibraryListPath', () => {
  it('matches the default library', () => {
    expect(isLibraryListPath('/')).toBe(true);
  });

  it('matches a named collection list', () => {
    expect(isLibraryListPath('/collections/abc-123')).toBe(true);
  });

  it('does not match collection import or new-recipe', () => {
    expect(isLibraryListPath('/collections/abc/import')).toBe(false);
    expect(isLibraryListPath('/collections/abc/recipe/new')).toBe(false);
  });

  it('does not match junk collection paths', () => {
    expect(isLibraryListPath('/collections/foo/bar')).toBe(false);
    expect(isLibraryListPath('/collections')).toBe(false);
  });

  it('does not match other app routes', () => {
    expect(isLibraryListPath('/recipe/1')).toBe(false);
    expect(isLibraryListPath('/settings')).toBe(false);
  });
});
