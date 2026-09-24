import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_GRANTS,
  addGrantTransition,
  cascadeGrantPairTransition,
  collectionLiveForGrant,
  grantCascadeRevoke,
  incomingShareCascadeDoc,
  incomingShareFromGrant,
  normalizeShareEmail,
  parseGrantDoc,
  parseIncomingShareDoc,
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

describe('collectionLiveForGrant', () => {
  it('matches isLiveDoc for collection reads', () => {
    expect(collectionLiveForGrant(undefined)).toBe(false);
    expect(collectionLiveForGrant({ updatedAt: 1 })).toBe(true);
    expect(collectionLiveForGrant({ updatedAt: 1, deletedAt: 2 })).toBe(false);
  });
});

describe('incomingShareCascadeDoc', () => {
  const ownerSub = 'owner';
  const cascadeAt = 100;

  it('tombstones when absent or updatedAt is at or before cascadeAt', () => {
    expect(incomingShareCascadeDoc(undefined, ownerSub, collectionId, cascadeAt)).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
    expect(
      incomingShareCascadeDoc(
        { ownerSub, collectionId, updatedAt: cascadeAt },
        ownerSub,
        collectionId,
        cascadeAt,
      ),
    ).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
    expect(
      incomingShareCascadeDoc(
        { ownerSub, collectionId, updatedAt: 50 },
        ownerSub,
        collectionId,
        cascadeAt,
      ),
    ).toEqual({
      ownerSub,
      collectionId,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
  });

  it('skips when a newer live share has updatedAt after cascadeAt', () => {
    expect(
      incomingShareCascadeDoc(
        { ownerSub, collectionId, updatedAt: cascadeAt + 1 },
        ownerSub,
        collectionId,
        cascadeAt,
      ),
    ).toBeNull();
  });
});

describe('grantCascadeRevoke', () => {
  const cascadeAt = 100;
  const liveGrant = {
    viewerSub,
    email: 'a@b.c',
    collectionId,
    createdAt: 1,
    updatedAt: 50,
  };

  it('tombstones when absent or updatedAt is at or before cascadeAt', () => {
    expect(grantCascadeRevoke(null, viewerSub, cascadeAt)).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
    expect(grantCascadeRevoke(liveGrant, viewerSub, cascadeAt)).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
    expect(
      grantCascadeRevoke(
        { viewerSub, updatedAt: cascadeAt, deletedAt: cascadeAt },
        viewerSub,
        cascadeAt,
      ),
    ).toEqual({
      viewerSub,
      updatedAt: cascadeAt,
      deletedAt: cascadeAt,
    });
  });

  it('skips when a live grant has updatedAt after cascadeAt', () => {
    expect(
      grantCascadeRevoke(
        { ...liveGrant, updatedAt: cascadeAt + 1 },
        viewerSub,
        cascadeAt,
      ),
    ).toBeNull();
  });
});

describe('cascadeGrantPairTransition', () => {
  const ownerSub = 'owner';
  const cascadeAt = 100;

  it('tombstones both sides when neither doc is newer than cascadeAt', () => {
    const result = cascadeGrantPairTransition({
      existingGrant: {
        viewerSub,
        email: 'a@b.c',
        collectionId,
        createdAt: 1,
        updatedAt: 50,
      },
      existingShare: { ownerSub, collectionId, updatedAt: 50 },
      viewerSub,
      ownerSub,
      collectionId,
      cascadeAt,
    });
    expect(result).toEqual({
      grant: { viewerSub, updatedAt: cascadeAt, deletedAt: cascadeAt },
      share: {
        ownerSub,
        collectionId,
        updatedAt: cascadeAt,
        deletedAt: cascadeAt,
      },
    });
  });

  it('skips both when either side is newer than cascadeAt', () => {
    expect(
      cascadeGrantPairTransition({
        existingGrant: {
          viewerSub,
          email: 'a@b.c',
          collectionId,
          createdAt: 1,
          updatedAt: cascadeAt + 1,
        },
        existingShare: { ownerSub, collectionId, updatedAt: 50 },
        viewerSub,
        ownerSub,
        collectionId,
        cascadeAt,
      }),
    ).toBeNull();
    expect(
      cascadeGrantPairTransition({
        existingGrant: null,
        existingShare: { ownerSub, collectionId, updatedAt: cascadeAt + 1 },
        viewerSub,
        ownerSub,
        collectionId,
        cascadeAt,
      }),
    ).toBeNull();
  });
});

describe('parseIncomingShareDoc', () => {
  it('parses a stored incoming share', () => {
    expect(
      parseIncomingShareDoc({
        ownerSub: 'owner',
        collectionId,
        updatedAt: 3,
        ownerEmail: 'o@e.c',
      }),
    ).toEqual({
      ownerSub: 'owner',
      collectionId,
      updatedAt: 3,
      ownerEmail: 'o@e.c',
    });
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
