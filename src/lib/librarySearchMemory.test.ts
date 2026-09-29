import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedLibraryView,
  readPersistedLibraryView,
  writePersistedLibraryView,
} from './librarySearchMemory';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('librarySearchMemory', () => {
  it('round-trips the query and scope', () => {
    writePersistedLibraryView({ query: 'pasta', browseAll: true });
    expect(readPersistedLibraryView()).toEqual({ query: 'pasta', browseAll: true });
  });

  it('keeps the scope when the query is empty', () => {
    writePersistedLibraryView({ query: '', browseAll: true });
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: true });
  });

  it('removes the key for an empty, unwidened view', () => {
    writePersistedLibraryView({ query: 'pasta', browseAll: false });
    writePersistedLibraryView({ query: '', browseAll: false });
    expect(store.size).toBe(0);
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: false });
  });

  it('clear removes a stored view', () => {
    writePersistedLibraryView({ query: 'cake', browseAll: true });
    clearPersistedLibraryView();
    expect(store.size).toBe(0);
  });

  it('ignores a corrupt stored value', () => {
    store.set('cook.librarySearch', 'not json');
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: false });
  });
});
