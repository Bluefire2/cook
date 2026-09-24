import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPushRejection, pushOps } from './remote';
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
