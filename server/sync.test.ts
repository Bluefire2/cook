import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyPushOp,
  collectionDeleteCascadeAt,
  syncPull,
  syncPush,
} from './sync.ts';
import { compareMutation, decodePullCursor, encodePullCursor, validatePushOp } from './store.ts';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
  process.env.ALLOWED_EMAILS = 'allowed@example.com';
  process.env.PUBLIC_ORIGIN = 'http://localhost:5173';
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
});

describe('cursor helpers', () => {
  it('round-trips', () => {
    const c = {
      chatMessages: [50, '22222222-2222-4222-8222-222222222222'] as [number, string],
    };
    expect(decodePullCursor(encodePullCursor(c))).toEqual(c);
  });
});

describe('validatePushOp', () => {
  it('rejects missing id on recipe.put', () => {
    expect(
      validatePushOp({
        kind: 'recipe.put',
        payload: { title: 'x', servings: 1, ingredientSections: [], steps: [], tags: [], createdAt: 1, updatedAt: 1 },
      }).ok,
    ).toBe(false);
  });
});

describe('compareMutation ordering', () => {
  it('prefers newer puts', () => {
    expect(compareMutation({ updatedAt: 3 }, 5, 'put').allow).toBe(true);
    expect(compareMutation({ updatedAt: 7 }, 5, 'put').allow).toBe(false);
  });
});

describe('syncPush ignores body uid', () => {
  it('returns 401 without session', async () => {
    const res = await syncPush(
      new Request('http://localhost/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: [], uid: 'someone-else' }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('applyPushOp unknown kind', () => {
  it('returns unknown', async () => {
    const result = await applyPushOp('sub-1', { kind: 'photo.put', payload: {} });
    expect(result).toEqual({ applied: false, reason: 'unknown' });
  });
});

describe('syncPull unauthorized', () => {
  it('returns 401 without cookie', async () => {
    const res = await syncPull(new Request('http://localhost/api/sync/pull'));
    expect(res.status).toBe(401);
  });
});

describe('collectionDeleteCascadeAt', () => {
  it.each([
    {
      name: 'applied delete uses the accepted request timestamp',
      result: { applied: true, serverUpdatedAt: 999 } as const,
      acceptedAt: 100,
      expected: 100,
    },
    {
      name: 'rejected delete retries at the same stored tombstone timestamp',
      result: {
        applied: false,
        reason: 'stale',
        current: { updatedAt: 100, deletedAt: 100 },
      } as const,
      acceptedAt: 100,
      expected: 100,
    },
    {
      name: 'rejected stale delete retries at the newer stored tombstone timestamp',
      result: {
        applied: false,
        reason: 'stale',
        current: { updatedAt: 200, deletedAt: 200 },
      } as const,
      acceptedAt: 100,
      expected: 200,
    },
    {
      name: 'rejected stale delete skips a newer live collection',
      result: {
        applied: false,
        reason: 'stale',
        current: { updatedAt: 200 },
      } as const,
      acceptedAt: 100,
      expected: undefined,
    },
    {
      name: 'rejected delete skips a malformed tombstone',
      result: {
        applied: false,
        reason: 'stale',
        current: { updatedAt: 200, deletedAt: 199 },
      } as const,
      acceptedAt: 100,
      expected: undefined,
    },
    {
      name: 'rejected delete skips an absent current state',
      result: { applied: false, reason: 'stale' } as const,
      acceptedAt: 100,
      expected: undefined,
    },
  ])('$name', ({ result, acceptedAt, expected }) => {
    expect(collectionDeleteCascadeAt(result, acceptedAt)).toBe(expected);
  });
});
