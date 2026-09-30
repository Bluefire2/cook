import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSession, getSessionSnapshot, setupSessionTriggers, subscribeSession } from './session';
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

  it('keeps a cached user offline on 503 and does not sign them out', async () => {
    respond(200, { user });
    await fetchSession();
    expect(localStorage.getItem('cook.session')).toContain('sub-1');

    respond(503, { error: 'Membership unavailable' });
    await expect(fetchSession()).resolves.toEqual({ status: 'offline', user });
    expect(getSessionSnapshot()).toEqual({ user, status: 'offline' });
    expect(localStorage.getItem('cook.session')).toContain('sub-1');
  });

  it('shares one in-flight read across overlapping callers', async () => {
    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let mode: 'gate' | '503' = 'gate';
    const fetchMock = vi.fn(() => {
      if (mode === 'gate') return gate;
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Membership unavailable' }), { status: 503 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchSession();
    const second = fetchSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(new Response(JSON.stringify({ user }), { status: 200 }));
    await expect(first).resolves.toEqual({ status: 'signedIn', user });
    await expect(second).resolves.toEqual({ status: 'signedIn', user });

    mode = '503';
    await expect(fetchSession()).resolves.toEqual({ status: 'offline', user });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSessionSnapshot()).toEqual({ user, status: 'offline' });
  });

  it('shares one in-flight 503 and stays offline', async () => {
    respond(200, { user });
    await fetchSession();

    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(() => gate));

    const first = fetchSession();
    const second = fetchSession();
    release(new Response(JSON.stringify({ error: 'Membership unavailable' }), { status: 503 }));
    await expect(first).resolves.toEqual({ status: 'offline', user });
    await expect(second).resolves.toEqual({ status: 'offline', user });
    expect(getSessionSnapshot().status).not.toBe('signedOut');
    expect(localStorage.getItem('cook.session')).toContain('sub-1');
  });
});

describe('setupSessionTriggers', () => {
  function installDom(): {
    visibility: Array<() => void>;
    online: Array<() => void>;
    setVisibility: (state: DocumentVisibilityState) => void;
  } {
    const visibility: Array<() => void> = [];
    const online: Array<() => void> = [];
    let visibilityState: DocumentVisibilityState = 'visible';
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener(type: string, listener: () => void) {
        if (type === 'visibilitychange') visibility.push(listener);
      },
      removeEventListener() {},
    });
    vi.stubGlobal('window', {
      addEventListener(type: string, listener: () => void) {
        if (type === 'online') online.push(listener);
      },
    });
    return {
      visibility,
      online,
      setVisibility(state) {
        visibilityState = state;
      },
    };
  }

  it('refreshes once per visible or online event, and once when they overlap', async () => {
    const dom = installDom();
    let release: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setupSessionTriggers();
    expect(dom.visibility).toHaveLength(1);
    expect(dom.online).toHaveLength(1);

    dom.setVisibility('hidden');
    dom.visibility[0]();
    expect(fetchMock).not.toHaveBeenCalled();

    dom.setVisibility('visible');
    dom.visibility[0]();
    dom.online[0]();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const settled = fetchSession();
    release(new Response(JSON.stringify({ user }), { status: 200 }));
    await settled;
    expect(getSessionSnapshot().status).toBe('signedIn');

    dom.online[0]();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const again = fetchSession();
    release(new Response(JSON.stringify({ user }), { status: 200 }));
    await again;
  });
});
