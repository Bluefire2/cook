import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readPersistedLibrarySearch,
  writePersistedLibrarySearch,
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
  it('round-trips a non-empty query', () => {
    writePersistedLibrarySearch('pasta');
    expect(readPersistedLibrarySearch()).toBe('pasta');
  });

  it('can clear an explicit empty write', () => {
    writePersistedLibrarySearch('pasta');
    writePersistedLibrarySearch('');
    expect(readPersistedLibrarySearch()).toBe('');
  });
});
