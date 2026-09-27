import { describe, expect, it } from 'vitest';
import {
  collectionIdFromPath,
  grantPostHttpStatusForCollectionRead,
  revokeGrantHttpResponse,
} from './grantsHttp.ts';

const id = '11111111-1111-4111-8111-111111111111';

describe('collectionIdFromPath', () => {
  it('reads a collection UUID from grant routes', () => {
    expect(collectionIdFromPath(`/api/collections/${id}/grants`)).toBe(id);
    expect(collectionIdFromPath(`/api/collections/${id}/grants/revoke`)).toBe(id);
    expect(collectionIdFromPath(`/api/collections/not-a-uuid/grants`)).toBeNull();
    expect(collectionIdFromPath('/api/sync/shared')).toBeNull();
  });
});

describe('grantPostHttpStatusForCollectionRead', () => {
  it('returns 404 for a missing or tombstoned collection read', () => {
    expect(grantPostHttpStatusForCollectionRead(undefined)).toBe(404);
    expect(grantPostHttpStatusForCollectionRead({ updatedAt: 1, deletedAt: 2 })).toBe(
      404,
    );
    expect(grantPostHttpStatusForCollectionRead({ updatedAt: 1 })).toBeNull();
  });
});

describe('revokeGrantHttpResponse', () => {
  it('maps malformed and missing grants to generic client errors', async () => {
    const malformed = revokeGrantHttpResponse({ kind: 'badRequest' });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Bad request' });

    const missing = revokeGrantHttpResponse({ kind: 'missing' });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('maps live and already-tombstoned grants to idempotent success', async () => {
    for (const outcome of [
      {
        kind: 'write' as const,
        doc: { viewerSub: 'viewer', updatedAt: 9, deletedAt: 9, active: false as const },
      },
      {
        kind: 'already' as const,
        doc: { viewerSub: 'viewer', updatedAt: 4, deletedAt: 4, active: false as const },
      },
    ]) {
      const response = revokeGrantHttpResponse(outcome);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    }
  });
});
