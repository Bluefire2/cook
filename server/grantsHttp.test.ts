import { describe, expect, it } from 'vitest';
import {
  collectionIdFromPath,
  grantPostHttpStatusForCollectionRead,
  handleRevokeGrantRequest,
  handleSharedLeaveRequest,
  leaveGrantHttpResponse,
  revokeGrantHttpResponse,
  shareGrantErrorResponse,
  type LeaveGrantRequestDependencies,
  type RevokeGrantRequestDependencies,
} from './grantsHttp.ts';
import { MAX_LIVE_GRANTS, NO_ACCOUNT_MESSAGE, type RevokeGrantOutcome } from './grants.ts';

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

describe('handleRevokeGrantRequest', () => {
  const url = `http://localhost/api/collections/${id}/grants/revoke`;
  const post = (body: string) => new Request(url, { method: 'POST', body });
  type Access = Awaited<
    ReturnType<RevokeGrantRequestDependencies['requireOwnedLiveCollection']>
  >;
  function dependencies(
    access: Access,
    outcome: RevokeGrantOutcome | Error = { kind: 'missing' },
  ) {
    const calls: string[] = [];
    const deps: RevokeGrantRequestDependencies = {
      requireOwnedLiveCollection: async (_req, collectionId) => {
        calls.push(`access:${collectionId}`);
        return access;
      },
      revoke: async (ownerSub, collectionId, viewerSub) => {
        calls.push(`revoke:${ownerSub}:${collectionId}:${viewerSub}`);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    };
    return { deps, calls };
  }
  const owner: Access = { kind: 'ok', sub: 'owner', email: 'owner@example.com' };

  it('answers denied and unknown membership before reading a malformed body', async () => {
    for (const [access, status] of [
      [{ kind: 'denied' }, 401],
      [{ kind: 'unknown' }, 503],
      [{ kind: 'missing' }, 404],
    ] as Array<[Access, number]>) {
      const { deps, calls } = dependencies(access);
      const response = await handleRevokeGrantRequest(post('{not json'), deps);
      expect(response.status).toBe(status);
      expect(calls).toEqual([`access:${id}`]);
    }
  });

  it('returns 400 for a malformed body only after the owner is authorized', async () => {
    for (const body of ['{not json', '{}', JSON.stringify({ sub: 'a/b' })]) {
      const { deps, calls } = dependencies(owner);
      const response = await handleRevokeGrantRequest(post(body), deps);
      expect(response.status).toBe(400);
      expect(calls).toEqual([`access:${id}`]);
    }
  });

  it('keeps missing → 404, repeat revoke → 200, and store failure → 503', async () => {
    const body = JSON.stringify({ sub: 'viewer' });
    const missing = dependencies(owner, { kind: 'missing' });
    expect((await handleRevokeGrantRequest(post(body), missing.deps)).status).toBe(404);
    expect(missing.calls).toEqual([`access:${id}`, `revoke:owner:${id}:viewer`]);

    const already = dependencies(owner, {
      kind: 'already',
      doc: { viewerSub: 'viewer', updatedAt: 4, deletedAt: 4, active: false },
    });
    expect((await handleRevokeGrantRequest(post(body), already.deps)).status).toBe(200);

    const failing = dependencies(owner, new Error('firestore blip'));
    expect((await handleRevokeGrantRequest(post(body), failing.deps)).status).toBe(503);
  });

  it('rejects a non-UUID collection path before auth', async () => {
    const { deps, calls } = dependencies(owner);
    const response = await handleRevokeGrantRequest(
      new Request('http://localhost/api/collections/nope/grants/revoke', {
        method: 'POST',
        body: '{}',
      }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('shareGrantErrorResponse', () => {
  it('names the sharing refusals and keeps the English sentence', async () => {
    const self = shareGrantErrorResponse('self');
    expect(self.status).toBe(400);
    await expect(self.json()).resolves.toEqual({
      error: 'Cannot share with yourself',
      code: 'share-self',
    });

    const missing = shareGrantErrorResponse('no-account');
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: NO_ACCOUNT_MESSAGE,
      code: 'share-no-account',
    });

    const full = shareGrantErrorResponse('full');
    expect(full.status).toBe(409);
    await expect(full.json()).resolves.toEqual({
      error: `This collection already has ${MAX_LIVE_GRANTS} people`,
      code: 'share-full',
      max: MAX_LIVE_GRANTS,
    });
  });
});

describe('handleSharedLeaveRequest', () => {
  const url = 'http://localhost/api/shared/leave';
  const post = (body: string) => new Request(url, { method: 'POST', body });
  type Access = Awaited<
    ReturnType<LeaveGrantRequestDependencies['requireMember']>
  >;
  function dependencies(
    access: Access,
    outcome: RevokeGrantOutcome | Error = { kind: 'missing' },
  ) {
    const calls: string[] = [];
    const deps: LeaveGrantRequestDependencies = {
      requireMember: async () => {
        calls.push('access');
        return access;
      },
      leave: async (ownerSub, collectionId, viewerSub) => {
        calls.push(`leave:${ownerSub}:${collectionId}:${viewerSub}`);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    };
    return { deps, calls };
  }
  const member: Access = { kind: 'ok', sub: 'grantee', email: 'g@example.com', isOwner: false };
  const ownerSub = 'owner-sub';
  const collectionId = '11111111-1111-4111-8111-111111111111';

  it('answers denied and unknown membership before reading a malformed body', async () => {
    for (const [access, status] of [
      [{ kind: 'denied' }, 401],
      [{ kind: 'unknown' }, 503],
    ] as Array<[Access, number]>) {
      const { deps, calls } = dependencies(access);
      const response = await handleSharedLeaveRequest(post('{not json'), deps);
      expect(response.status).toBe(status);
      expect(calls).toEqual(['access']);
    }
  });

  it('returns 400 for a malformed body only after membership is checked', async () => {
    for (const body of [
      '{not json',
      '{}',
      JSON.stringify({ ownerSub }),
      JSON.stringify({ collectionId }),
      JSON.stringify({ ownerSub: 'a/b', collectionId }),
      JSON.stringify({ ownerSub, collectionId: 'not-a-uuid' }),
    ]) {
      const { deps, calls } = dependencies(member);
      const response = await handleSharedLeaveRequest(post(body), deps);
      expect(response.status).toBe(400);
      expect(calls).toEqual(['access']);
    }
  });

  it('never trusts a sub in the body: the leave call always uses the session sub', async () => {
    const body = JSON.stringify({ ownerSub, collectionId, sub: 'someone-else' });
    const { deps, calls } = dependencies(member, { kind: 'missing' });
    await handleSharedLeaveRequest(post(body), deps);
    expect(calls).toEqual(['access', `leave:${ownerSub}:${collectionId}:grantee`]);
  });

  it('maps missing, already-gone, and a store failure all to a non-resurrecting result', async () => {
    const body = JSON.stringify({ ownerSub, collectionId });

    const missing = dependencies(member, { kind: 'missing' });
    expect((await handleSharedLeaveRequest(post(body), missing.deps)).status).toBe(404);

    const already = dependencies(member, {
      kind: 'already',
      doc: { viewerSub: 'grantee', updatedAt: 4, deletedAt: 4, active: false },
    });
    expect((await handleSharedLeaveRequest(post(body), already.deps)).status).toBe(404);

    const written = dependencies(member, {
      kind: 'write',
      doc: { viewerSub: 'grantee', updatedAt: 9, deletedAt: 9, active: false },
    });
    const ok = await handleSharedLeaveRequest(post(body), written.deps);
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ ok: true });

    const failing = dependencies(member, new Error('firestore blip'));
    expect((await handleSharedLeaveRequest(post(body), failing.deps)).status).toBe(503);
  });
});

describe('leaveGrantHttpResponse', () => {
  it('treats a second leave (already tombstoned) the same as never having a grant', async () => {
    const malformed = leaveGrantHttpResponse({ kind: 'badRequest' });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Bad request', code: 'bad-request' });

    const missing = leaveGrantHttpResponse({ kind: 'missing' });
    expect(missing.status).toBe(404);

    const already = leaveGrantHttpResponse({
      kind: 'already',
      doc: { viewerSub: 'grantee', updatedAt: 4, deletedAt: 4, active: false },
    });
    expect(already.status).toBe(404);

    const write = leaveGrantHttpResponse({
      kind: 'write',
      doc: { viewerSub: 'grantee', updatedAt: 9, deletedAt: 9, active: false },
    });
    expect(write.status).toBe(200);
  });
});

describe('revokeGrantHttpResponse', () => {
  it('maps malformed and missing grants to generic client errors', async () => {
    const malformed = revokeGrantHttpResponse({ kind: 'badRequest' });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Bad request', code: 'bad-request' });

    const missing = revokeGrantHttpResponse({ kind: 'missing' });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'Not found', code: 'not-found' });
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
