import { beforeEach, describe, expect, it } from 'vitest';
import { FULL_COOK_LOG, FULL_COOK_LOG_UNCOMPACTED } from '../test/cookLogFixtures.ts';
import { applyPushOp, docToChange, STORE_KINDS, syncPull, syncPush } from './sync.ts';
import {
  compareMutation,
  decodePullCursor,
  encodePullCursor,
  isKnownPushKind,
  validatePushOp,
} from './store.ts';

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

describe('applyPushOp cook log ops', () => {
  it('are known kinds', () => {
    expect(isKnownPushKind('cookLog.put')).toBe(true);
    expect(isKnownPushKind('cookLog.delete')).toBe(true);
  });

  it('rejects an invalid cookLog.put before touching the store', async () => {
    const result = await applyPushOp('sub-1', {
      kind: 'cookLog.put',
      payload: { ...FULL_COOK_LOG, cookedOn: '2026-02-30' },
    });
    expect(result).toEqual({ applied: false, reason: 'invalid' });
  });

  it('rejects an invalid cookLog.delete before touching the store', async () => {
    const result = await applyPushOp('sub-1', {
      kind: 'cookLog.delete',
      payload: { id: FULL_COOK_LOG.id },
    });
    expect(result).toEqual({ applied: false, reason: 'invalid' });
  });
});

describe('pull kinds', () => {
  it('pulls every store kind, including cookLogs', () => {
    expect(STORE_KINDS).toEqual([
      'recipes',
      'chatMessages',
      'cookState',
      'photos',
      'collections',
      'cookLogs',
    ]);
  });

  it('compacts a live cook log doc and strips server fields', () => {
    expect(
      docToChange('cookLogs', { ...FULL_COOK_LOG_UNCOMPACTED, serverUpdatedAt: 9 }),
    ).toEqual(FULL_COOK_LOG);
  });

  it('returns a cook log tombstone as id and deletedAt', () => {
    expect(
      docToChange('cookLogs', { id: 'l1', updatedAt: 5, deletedAt: 5, serverUpdatedAt: 9 }),
    ).toEqual({ id: 'l1', deletedAt: 5 });
  });
});

describe('syncPull unauthorized', () => {
  it('returns 401 without cookie', async () => {
    const res = await syncPull(new Request('http://localhost/api/sync/pull'));
    expect(res.status).toBe(401);
  });
});
