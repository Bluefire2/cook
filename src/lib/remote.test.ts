import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPushRejection, pullSharedPage, pushOps } from './remote';
import type { PushOp } from './pushOps';
import { isDiscardedPushReason } from './pushReasons';

const op: PushOp = {
  kind: 'recipe.delete',
  payload: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', updatedAt: 1 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
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

describe('isDiscardedPushReason', () => {
  it('accepts only invalid, unknown, and cap', () => {
    expect(isDiscardedPushReason('invalid')).toBe(true);
    expect(isDiscardedPushReason('unknown')).toBe(true);
    expect(isDiscardedPushReason('cap')).toBe(true);
    expect(isDiscardedPushReason('caps')).toBe(false);
    expect(isDiscardedPushReason('stale')).toBe(false);
  });
});

describe('firstPushRejection', () => {
  it('returns the first discarded-write reason', () => {
    expect(firstPushRejection(null)).toBeNull();
    expect(firstPushRejection({})).toBeNull();
    expect(firstPushRejection({ results: [{ applied: true }] })).toBeNull();
    expect(firstPushRejection({ results: [{ applied: false }] })).toBeNull();
    expect(
      firstPushRejection({
        results: [
          { applied: false, reason: 'stale' },
          { applied: false, reason: 'invalid' },
          { applied: false, reason: 'unknown' },
        ],
      }),
    ).toBe('invalid');
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'cap' }] }),
    ).toBe('cap');
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'unknown' }] }),
    ).toBe('unknown');
  });

  it('ignores ordinary last-write-wins and cascade outcomes', () => {
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'stale' }] }),
    ).toBeNull();
    expect(
      firstPushRejection({
        results: [{ applied: false, reason: 'already-deleted' }],
      }),
    ).toBeNull();
    expect(
      firstPushRejection({
        results: [{ applied: false, reason: 'recipe-deleted' }],
      }),
    ).toBeNull();
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'caps' }] }),
    ).toBeNull();
  });
});

describe('pushOps', () => {
  it.each([
    [{ applied: false, reason: 'invalid' }, 'invalid'],
    [{ applied: false, reason: 'unknown' }, 'unknown'],
    [{ applied: false, reason: 'cap' }, 'cap'],
    [{ applied: false, reason: 'stale' }, 'ok'],
    [{ applied: false, reason: 'already-deleted' }, 'ok'],
    [{ applied: false, reason: 'recipe-deleted' }, 'ok'],
    [{ applied: false }, 'ok'],
    [{ applied: true }, 'ok'],
  ] as const)('maps %j to %s', async (entry, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [entry] })),
    );
    expect(await pushOps([op])).toBe(expected);
  });

  it('returns error when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await pushOps([op])).toBe('error');
  });

  it('returns error on a non-OK status other than 401/403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await pushOps([op])).toBe('error');
  });

  it('returns signedOut on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    expect(await pushOps([op])).toBe('signedOut');
  });
});

describe('pullSharedPage', () => {
  it('requests the hardcoded shared page limit', async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse({
          changes: { collections: [], recipes: [], photos: [] },
          cursorToken: 'signed-cursor',
          hasMore: false,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await pullSharedPage(null);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sync/shared?limit=200',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
    expect(page).toEqual({
      changes: { collections: [], recipes: [], photos: [] },
      cursorToken: 'signed-cursor',
      hasMore: false,
    });
  });

  it('maps only the typed snapshot-changed response to restart', async () => {
    localStorage.setItem('cook.session', 'present');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'shared-snapshot-changed' }, 409),
      ),
    );
    expect(await pullSharedPage('stale-cursor')).toBe('restart');
    expect(localStorage.getItem('cook.session')).toBe('present');
  });

  it('does not treat HTTP 200 as a generation restart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          error: 'shared-snapshot-changed',
          changes: { collections: [], recipes: [], photos: [] },
          cursorToken: 'token',
          hasMore: false,
        }),
      ),
    );
    const page = await pullSharedPage('stale-cursor');
    expect(page).not.toBe('restart');
    expect(page).toMatchObject({ hasMore: false, cursorToken: 'token' });
  });

  it('keeps other non-2xx responses on the existing error path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'shared-snapshot-changed' }, 500)),
    );
    expect(await pullSharedPage('cursor')).toBe('error');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 409)),
    );
    expect(await pullSharedPage('cursor')).toBe('error');
  });

  it('keeps 401 and 403 as signed out', async () => {
    localStorage.setItem('cook.session', 'present');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'shared-snapshot-changed' }, 401)),
    );
    expect(await pullSharedPage('cursor')).toBe('signedOut');
    expect(localStorage.getItem('cook.session')).toBeNull();

    localStorage.setItem('cook.session', 'present');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'shared-snapshot-changed' }, 403)),
    );
    expect(await pullSharedPage('cursor')).toBe('signedOut');
    expect(localStorage.getItem('cook.session')).toBeNull();
  });
});
