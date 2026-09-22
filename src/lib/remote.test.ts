import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstPushRejection, pushBatchRejected, pushOps } from './remote';
import type { PushOp } from './pushOps';

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

describe('firstPushRejection', () => {
  it('returns the first discarded-write reason', () => {
    expect(firstPushRejection(null)).toBeNull();
    expect(firstPushRejection({ results: [{ applied: true }] })).toBeNull();
    expect(
      firstPushRejection({
        results: [
          { applied: false, reason: 'stale' },
          { applied: false, reason: 'invalid' },
          { applied: false, reason: 'unknown' },
        ],
      }),
    ).toBe('invalid');
  });
});

describe('pushBatchRejected', () => {
  it('is false when results are missing or applied', () => {
    expect(pushBatchRejected(null)).toBe(false);
    expect(pushBatchRejected({})).toBe(false);
    expect(pushBatchRejected({ results: [{ applied: true }] })).toBe(false);
    expect(pushBatchRejected({ results: [{ applied: false }] })).toBe(false);
  });

  it('is true only for invalid and unknown', () => {
    expect(
      pushBatchRejected({ results: [{ applied: false, reason: 'invalid' }] }),
    ).toBe(true);
    expect(
      pushBatchRejected({ results: [{ applied: false, reason: 'unknown' }] }),
    ).toBe(true);
    expect(
      pushBatchRejected({ results: [{ applied: false, reason: 'stale' }] }),
    ).toBe(false);
    expect(
      pushBatchRejected({
        results: [{ applied: false, reason: 'already-deleted' }],
      }),
    ).toBe(false);
    expect(
      pushBatchRejected({
        results: [{ applied: false, reason: 'recipe-deleted' }],
      }),
    ).toBe(false);
  });
});

describe('pushOps', () => {
  it.each([
    [{ applied: false, reason: 'invalid' }, 'invalid'],
    [{ applied: false, reason: 'unknown' }, 'unknown'],
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
