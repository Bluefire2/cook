import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_GRANTS,
  addGrantTransition,
  changeGrantRoleTransition,
  incomingSharePayload,
  orchestrateGrantAdd,
  orchestrateGrantRoleChange,
  parseGrantDoc,
  parseIncomingShareDoc,
  type GrantAddOnExisting,
  type GrantRoleOutcome,
  type GrantRoleTransaction,
  type IncomingShareDoc,
} from './grants.ts';
import {
  collectionIdFromPath,
  handleGrantRoleRequest,
  type GrantRoleRequestDependencies,
} from './grantsHttp.ts';

const viewerSub = 'viewer-1';
const collectionId = '11111111-1111-4111-8111-111111111111';

const liveDoc = {
  viewerSub,
  email: 'viewer@example.com',
  collectionId,
  createdAt: 1,
  updatedAt: 2,
};

describe('grant roles', () => {
  it('reads a grant written before roles as a viewer', () => {
    expect(parseGrantDoc(liveDoc, viewerSub)).toMatchObject({ role: 'viewer', active: true });
    expect(parseGrantDoc({ ...liveDoc, role: 'owner' }, viewerSub)).toMatchObject({
      role: 'viewer',
    });
    expect(parseGrantDoc({ ...liveDoc, role: 'editor' }, viewerSub)).toMatchObject({
      role: 'editor',
    });
  });

  it('copies the role into the reverse share, and not onto a tombstone', () => {
    expect(
      parseIncomingShareDoc({ ownerSub: 'owner', collectionId, updatedAt: 1, role: 'editor' }),
    ).toEqual({ ownerSub: 'owner', collectionId, updatedAt: 1, role: 'editor' });
    expect(
      parseIncomingShareDoc({ ownerSub: 'owner', collectionId, updatedAt: 1 }),
    ).not.toHaveProperty('role');
    expect(
      incomingSharePayload('owner', collectionId, 3, { role: 'editor', deletedAt: 3 }),
    ).not.toHaveProperty('role');
    expect(
      addGrantTransition({
        existing: null,
        viewerSub,
        email: liveDoc.email,
        collectionId,
        role: 'editor',
        now: 10,
        liveCount: 0,
      }),
    ).toMatchObject({ kind: 'write', doc: { role: 'editor' } });
  });

  it('counts editors and viewers against one cap', () => {
    expect(
      addGrantTransition({
        existing: null,
        viewerSub,
        email: liveDoc.email,
        collectionId,
        role: 'editor',
        now: 10,
        liveCount: MAX_LIVE_GRANTS,
      }).kind,
    ).toBe('cap');
  });

  it('changes only a live grant, and a same-role change is a no-op', () => {
    const live = parseGrantDoc(liveDoc, viewerSub);
    expect(changeGrantRoleTransition({ existing: null, role: 'editor', now: 9 })).toEqual({
      kind: 'missing',
    });
    expect(
      changeGrantRoleTransition({
        existing: { viewerSub, updatedAt: 4, deletedAt: 4, active: false },
        role: 'editor',
        now: 9,
      }),
    ).toEqual({ kind: 'missing' });
    expect(changeGrantRoleTransition({ existing: live, role: 'viewer', now: 9 })).toMatchObject({
      kind: 'unchanged',
    });
    expect(changeGrantRoleTransition({ existing: live, role: 'editor', now: 9 })).toEqual({
      kind: 'write',
      doc: { ...live, role: 'editor', updatedAt: 9 },
    });
  });

  it('round-trips viewer → editor → viewer on both documents', async () => {
    const grants = new Map<string, Record<string, unknown>>([[viewerSub, liveDoc]]);
    const shares = new Map<string, IncomingShareDoc>([
      [
        viewerSub,
        { ownerSub: 'owner', collectionId, ownerEmail: 'owner@example.com', updatedAt: 2 },
      ],
    ]);
    const writes: string[] = [];
    const tx: GrantRoleTransaction = {
      readForwardGrant: async (sub) => parseGrantDoc(grants.get(sub), sub),
      readReverseShare: async (sub) => shares.get(sub),
      writePair: async (grant, share) => {
        writes.push(grant.role);
        grants.set(grant.viewerSub, grant);
        shares.set(grant.viewerSub, share);
      },
    };
    const change = (sub: unknown, role: 'viewer' | 'editor', now: number) =>
      orchestrateGrantRoleChange(
        { ownerSub: 'owner', collectionId, viewerSub: sub, role },
        now,
        { runTransaction: async (work) => work(tx) },
      );

    await expect(change(viewerSub, 'editor', 5)).resolves.toMatchObject({
      kind: 'write',
      doc: { role: 'editor', updatedAt: 5, createdAt: 1 },
    });
    expect(parseGrantDoc(grants.get(viewerSub), viewerSub)).toMatchObject({ role: 'editor' });
    expect(shares.get(viewerSub)).toEqual({
      ownerSub: 'owner',
      collectionId,
      ownerEmail: 'owner@example.com',
      role: 'editor',
      updatedAt: 5,
    });

    await expect(change(viewerSub, 'editor', 6)).resolves.toMatchObject({ kind: 'unchanged' });
    await expect(change(viewerSub, 'viewer', 7)).resolves.toMatchObject({ kind: 'write' });
    expect(parseGrantDoc(grants.get(viewerSub), viewerSub)).toMatchObject({ role: 'viewer' });
    expect(shares.get(viewerSub)).toMatchObject({ role: 'viewer', updatedAt: 7 });
    expect(writes).toEqual(['editor', 'viewer']);

    await expect(change('a/b', 'editor', 8)).resolves.toEqual({ kind: 'badRequest' });
    await expect(change('someone-else', 'editor', 8)).resolves.toEqual({ kind: 'missing' });
  });
});

describe('grant add for someone already granted', () => {
  function run(stored: 'viewer' | 'editor', requested: 'viewer' | 'editor', onExisting: GrantAddOnExisting) {
    const grants = new Map<string, Record<string, unknown>>([
      [viewerSub, { ...liveDoc, role: stored }],
    ]);
    const shares = new Map<string, IncomingShareDoc>([
      [viewerSub, { ownerSub: 'owner', collectionId, ownerEmail: 'owner@example.com', role: stored, updatedAt: 2 }],
    ]);
    const writes: string[] = [];
    const outcome = orchestrateGrantAdd(
      {
        ownerSub: 'owner',
        ownerEmail: 'owner@example.com',
        collectionId,
        viewerSub,
        email: liveDoc.email,
        role: requested,
        onExisting,
      },
      {
        now: () => 9,
        runTransaction: async (work) =>
          work({
            readCollection: async () => ({ id: collectionId, name: 'Dinners', recipeIds: [], updatedAt: 1 }),
            readForwardGrants: async () =>
              [...grants].map(([id, data]) => ({ id, data })),
            writePair: (grant, share) => {
              writes.push(grant.role);
              grants.set(grant.viewerSub, grant);
              shares.set(grant.viewerSub, share);
            },
          }),
      },
    );
    return { outcome, grants, shares, writes };
  }

  it('applyRole (add by email) writes the requested role on both documents', async () => {
    const up = run('viewer', 'editor', 'applyRole');
    await expect(up.outcome).resolves.toMatchObject({
      kind: 'write',
      doc: { role: 'editor', createdAt: 1, updatedAt: 9 },
    });
    expect(parseGrantDoc(up.grants.get(viewerSub), viewerSub)).toMatchObject({ role: 'editor' });
    expect(up.shares.get(viewerSub)).toEqual({
      ownerSub: 'owner',
      collectionId,
      ownerEmail: 'owner@example.com',
      role: 'editor',
      updatedAt: 9,
    });

    const down = run('editor', 'viewer', 'applyRole');
    await expect(down.outcome).resolves.toMatchObject({ kind: 'write', doc: { role: 'viewer' } });
    expect(down.shares.get(viewerSub)).toMatchObject({ role: 'viewer' });

    const same = run('editor', 'editor', 'applyRole');
    await expect(same.outcome).resolves.toMatchObject({ kind: 'idempotent', doc: { role: 'editor' } });
    expect(same.writes).toEqual([]);
  });

  it('keepRole never upgrades or downgrades an existing grant', async () => {
    for (const [stored, requested] of [
      ['viewer', 'editor'],
      ['editor', 'viewer'],
    ] as const) {
      const kept = run(stored, requested, 'keepRole');
      await expect(kept.outcome).resolves.toMatchObject({
        kind: 'idempotent',
        doc: { role: stored },
      });
      expect(kept.writes).toEqual([]);
      expect(kept.shares.get(viewerSub)).toMatchObject({ role: stored });
    }
  });
});

describe('handleGrantRoleRequest', () => {
  const url = `http://localhost/api/collections/${collectionId}/grants/role`;
  const post = (body: string) => new Request(url, { method: 'POST', body });
  type Access = Awaited<
    ReturnType<GrantRoleRequestDependencies['requireOwnedLiveCollection']>
  >;
  const owner: Access = { kind: 'ok', sub: 'owner', email: 'owner@example.com' };
  const editorGrant = {
    viewerSub: 'viewer',
    email: 'viewer@example.com',
    collectionId,
    role: 'editor' as const,
    createdAt: 1,
    updatedAt: 5,
    active: true as const,
  };
  function dependencies(access: Access, outcome: GrantRoleOutcome | Error = { kind: 'missing' }) {
    const calls: string[] = [];
    const deps: GrantRoleRequestDependencies = {
      requireOwnedLiveCollection: async (_req, id) => {
        calls.push(`access:${id}`);
        return access;
      },
      changeRole: async (ownerSub, id, sub, role) => {
        calls.push(`role:${ownerSub}:${id}:${sub}:${role}`);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    };
    return { deps, calls };
  }

  it('matches the role path', () => {
    expect(collectionIdFromPath(`/api/collections/${collectionId}/grants/role`)).toBe(
      collectionId,
    );
  });

  it('answers everyone but the collection owner before reading the body', async () => {
    for (const [access, status] of [
      [{ kind: 'denied' }, 401],
      [{ kind: 'unknown' }, 503],
      [{ kind: 'missing' }, 404],
    ] as Array<[Access, number]>) {
      const { deps, calls } = dependencies(access);
      const response = await handleGrantRoleRequest(
        post(JSON.stringify({ sub: 'viewer', role: 'editor' })),
        deps,
      );
      expect(response.status).toBe(status);
      expect(calls).toEqual([`access:${collectionId}`]);
    }
  });

  it('returns 400 for a bad role or sub', async () => {
    for (const body of [
      '{not json',
      JSON.stringify({ sub: 'viewer' }),
      JSON.stringify({ sub: 'viewer', role: 'owner' }),
      JSON.stringify({ sub: 'viewer', role: null }),
      JSON.stringify({ sub: 'a/b', role: 'editor' }),
    ]) {
      const { deps, calls } = dependencies(owner);
      expect((await handleGrantRoleRequest(post(body), deps)).status).toBe(400);
      expect(calls).toEqual([`access:${collectionId}`]);
    }
  });

  it('maps a missing grant to 404, a change to 200 with the role, and a store throw to 503', async () => {
    const body = JSON.stringify({ sub: 'viewer', role: 'editor' });
    const missing = dependencies(owner, { kind: 'missing' });
    expect((await handleGrantRoleRequest(post(body), missing.deps)).status).toBe(404);
    expect(missing.calls).toEqual([
      `access:${collectionId}`,
      `role:owner:${collectionId}:viewer:editor`,
    ]);

    for (const outcome of [
      { kind: 'write' as const, doc: editorGrant },
      { kind: 'unchanged' as const, doc: editorGrant },
    ]) {
      const response = await handleGrantRoleRequest(post(body), dependencies(owner, outcome).deps);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        grant: { sub: 'viewer', email: 'viewer@example.com', role: 'editor', createdAt: 1 },
      });
    }

    const failing = dependencies(owner, new Error('firestore blip'));
    expect((await handleGrantRoleRequest(post(body), failing.deps)).status).toBe(503);
  });
});
