import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSession, getSessionSnapshot, subscribeSession } from './session';
import { getSnapshot, upsertRecipe } from './libraryMemory';
import type { Recipe } from './types';

const store = new Map<string, string>();
const originalStorage = globalThis.localStorage;

beforeEach(() => {
  store.clear();
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
  vi.unstubAllGlobals();
  store.clear();
  if (originalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    globalThis.localStorage = originalStorage;
  }
});

const user = { sub: 'sub-1', email: 'a@example.com' };

function respond(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function recipe(id: string): Recipe {
  return {
    id,
    title: id,
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('session store', () => {
  it('keeps the same snapshot and stays quiet when a refetch returns the same session', async () => {
    respond(200, { user });
    await fetchSession();
    const first = getSessionSnapshot();
    expect(first).toEqual({ user, status: 'signedIn' });

    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);
    respond(200, { user: { ...user } });
    await fetchSession();
    unsubscribe();
    expect(getSessionSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes a new snapshot when a user field changes', async () => {
    respond(200, { user });
    await fetchSession();
    const first = getSessionSnapshot();

    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);
    respond(200, { user: { ...user, name: 'Me' } });
    await fetchSession();
    unsubscribe();
    expect(getSessionSnapshot()).not.toBe(first);
    expect(getSessionSnapshot().user?.name).toBe('Me');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on each published status and stops after unsubscribe', async () => {
    // Start signed out, whatever an earlier test left behind.
    respond(401);
    await fetchSession();
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);

    respond(200, { user });
    await fetchSession();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSessionSnapshot().status).toBe('signedIn');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await fetchSession();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSessionSnapshot()).toEqual({ user, status: 'offline' });

    unsubscribe();
    respond(200, { user });
    await fetchSession();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('publishes signedOut on 401 and clears the library', async () => {
    upsertRecipe(recipe('r1'));
    respond(401);
    await expect(fetchSession()).resolves.toEqual({ status: 'signedOut' });
    expect(getSessionSnapshot()).toEqual({ user: null, status: 'signedOut' });
    expect(getSnapshot().loaded).toBe(true);
    expect(getSnapshot().recipes.size).toBe(0);
  });
});
