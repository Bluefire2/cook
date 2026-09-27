import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateSession, onSessionReset } from './session';

const clearLibraryMock = vi.fn();

vi.mock('./libraryMemory', () => ({
  clearLibrary: () => clearLibraryMock(),
}));

beforeEach(() => {
  clearLibraryMock.mockClear();
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('onSessionReset', () => {
  it('notifies listeners when invalidateSession runs', () => {
    const seen: number[] = [];
    const unsub = onSessionReset(() => {
      seen.push(1);
    });
    invalidateSession();
    expect(seen).toEqual([1]);
    unsub();
  });

  it('stops notifying after unsubscribe', () => {
    const seen: number[] = [];
    const unsub = onSessionReset(() => {
      seen.push(1);
    });
    unsub();
    invalidateSession();
    expect(seen).toEqual([]);
  });

  it('runs clearLibrary before reset listeners and isolates throwing listeners', () => {
    const order: string[] = [];
    clearLibraryMock.mockImplementation(() => {
      order.push('clearLibrary');
    });
    onSessionReset(() => {
      order.push('first');
    });
    onSessionReset(() => {
      order.push('throw');
      throw new Error('boom');
    });
    onSessionReset(() => {
      order.push('second');
    });
    invalidateSession();
    expect(order).toEqual(['clearLibrary', 'first', 'throw', 'second']);
  });
});
