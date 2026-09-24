import { beforeEach, describe, expect, it } from 'vitest';
import { applyPushOp, shouldCascadeCollectionDelete, syncPull, syncPush } from './sync.ts';
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

describe('shouldCascadeCollectionDelete', () => {
  it('cascades only when tombstone delete was applied', () => {
    expect(shouldCascadeCollectionDelete({ applied: true, serverUpdatedAt: 50 })).toBe(true);
    expect(
      shouldCascadeCollectionDelete({
        applied: false,
        reason: 'stale',
        current: { updatedAt: 100 },
      }),
    ).toBe(false);
    expect(shouldCascadeCollectionDelete({ applied: false, reason: 'stale' })).toBe(false);
  });
});
