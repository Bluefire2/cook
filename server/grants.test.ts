import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_GRANTS,
  addGrantTransition,
  incomingShareFromGrant,
  normalizeShareEmail,
  parseGrantDoc,
  resolveShareTarget,
  revokeGrantTransition,
  shareGrantId,
} from './grants.ts';

const viewerSub = 'viewer-1';
const collectionId = '11111111-1111-4111-8111-111111111111';

describe('normalizeShareEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeShareEmail('  Alex@Example.com ')).toBe('alex@example.com');
    expect(normalizeShareEmail('')).toBeUndefined();
    expect(normalizeShareEmail('no-at')).toBeUndefined();
  });
});

describe('parseGrantDoc', () => {
  it('parses a live grant and a tombstone', () => {
    expect(
      parseGrantDoc(
        {
          viewerSub,
          email: 'alex@example.com',
          collectionId,
          createdAt: 1,
          updatedAt: 2,
        },
        viewerSub,
      ),
    ).toEqual({
      viewerSub,
      email: 'alex@example.com',
      collectionId,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(
      parseGrantDoc({ viewerSub, updatedAt: 3, deletedAt: 3 }, viewerSub),
    ).toEqual({ viewerSub, updatedAt: 3, deletedAt: 3 });
  });

  it('rejects the wrong viewer or a missing collection', () => {
    expect(
      parseGrantDoc(
        {
          viewerSub: 'other',
          email: 'a@b.c',
          collectionId,
          createdAt: 1,
          updatedAt: 2,
        },
        viewerSub,
      ),
    ).toBeNull();
  });
});

describe('addGrantTransition', () => {
  it('rejects adding yourself via resolveShareTarget', async () => {
    const self = await resolveShareTarget({
      email: 'me@example.com',
      actorSub: 'me',
      actorEmail: 'me@example.com',
      queryUsersByEmail: async () => [],
      isOwnerEmail: () => false,
      readMemberStatus: async () => null,
    });
    expect(self).toEqual({ kind: 'self' });
  });

  it('rejects a revoked member and treats a read throw as unknown', async () => {
    const revoked = await resolveShareTarget({
      email: 'revoked@example.com',
      actorSub: 'me',
      actorEmail: 'me@example.com',
      queryUsersByEmail: async () => [
        { sub: 'r1', email: 'revoked@example.com', lastSeenAt: 9 },
      ],
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'revoked',
    });
    expect(revoked).toEqual({ kind: 'notFound' });

    const unknown = await resolveShareTarget({
      email: 'x@y.z',
      actorSub: 'me',
      actorEmail: 'me@example.com',
      queryUsersByEmail: async () => [{ sub: 'x', email: 'x@y.z', lastSeenAt: 1 }],
      isOwnerEmail: () => false,
      readMemberStatus: async () => {
        throw new Error('blip');
      },
    });
    expect(unknown).toEqual({ kind: 'unknown' });
  });

  it('is idempotent for a live grant and caps at 20', () => {
    const live = {
      viewerSub,
      email: 'alex@example.com',
      collectionId,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(
      addGrantTransition({
        existing: live,
        viewerSub,
        email: live.email,
        collectionId,
        now: 10,
        liveCount: 1,
      }).kind,
    ).toBe('idempotent');
    expect(
      addGrantTransition({
        existing: null,
        viewerSub,
        email: live.email,
        collectionId,
        now: 10,
        liveCount: MAX_LIVE_GRANTS,
      }).kind,
    ).toBe('cap');
  });
});

describe('revokeGrantTransition', () => {
  it('tombstones a live grant and is a no-op on an existing tombstone', () => {
    const write = revokeGrantTransition({
      existing: {
        viewerSub,
        email: 'a@b.c',
        collectionId,
        createdAt: 1,
        updatedAt: 2,
      },
      viewerSub,
      now: 9,
    });
    expect(write).toEqual({
      kind: 'write',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9 },
    });
    expect(
      revokeGrantTransition({
        existing: { viewerSub, updatedAt: 4, deletedAt: 4 },
        viewerSub,
        now: 9,
      }).kind,
    ).toBe('already');
  });
});

describe('incomingShareFromGrant', () => {
  it('mirrors a tombstone onto the reverse index', () => {
    expect(
      incomingShareFromGrant('owner', collectionId, {
        viewerSub,
        updatedAt: 5,
        deletedAt: 5,
      }),
    ).toEqual({
      ownerSub: 'owner',
      collectionId,
      updatedAt: 5,
      deletedAt: 5,
    });
    expect(shareGrantId('owner', collectionId)).toBe(`owner_${collectionId}`);
  });
});
