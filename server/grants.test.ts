import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_GRANTS,
  addGrantTransition,
  cascadeGrantPairTransition,
  collectionLiveForGrant,
  grantCascadeRevoke,
  incomingShareCascadeDoc,
  isSafeFirestoreDocumentId,
  normalizeShareEmail,
  orchestrateGrantRevoke,
  parseGrantDoc,
  parseIncomingShareDoc,
  queryShareProfileRows,
  resolveShareTarget,
  revokeGrantTransition,
  sessionCanViewOwnerPhoto,
  type GrantTombstone,
  type LiveGrant,
  type LiveIncomingShare,
  type RevokeGrantDependencies,
  type SessionCanViewOwnerPhotoInput,
} from './grants.ts';
import type { StoreKind } from './store.ts';

const viewerSub = 'viewer-1';
const collectionId = '11111111-1111-4111-8111-111111111111';
const secondCollectionId = '22222222-2222-4222-8222-222222222222';
const recipeId = '33333333-3333-4333-8333-333333333333';
const secondRecipeId = '44444444-4444-4444-8444-444444444444';

function liveCollection(id: string, recipeIds: string[]) {
  return { id, name: 'Shared', recipeIds, createdAt: 1, updatedAt: 2 };
}

function liveRecipe(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Recipe ${id}`,
    servings: 2,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

function livePhoto(parentRecipeId: string) {
  return {
    id: 'photo-target',
    recipeId: parentRecipeId,
    status: 'live',
    contentType: 'image/jpeg',
    size: 10,
    updatedAt: 2,
  };
}

function docKey(uid: string, kind: StoreKind, id: string): string {
  return `${uid}/${kind}/${id}`;
}

function photoAccessInput(input: {
  ownerSub?: string;
  photoId?: string;
  shares: LiveIncomingShare[];
  current?: Map<string, LiveIncomingShare | undefined>;
  docs?: Map<string, Record<string, unknown> | undefined>;
  calls?: string[];
}): SessionCanViewOwnerPhotoInput {
  return {
    viewerSub,
    ownerSub: input.ownerSub ?? 'owner',
    photoId: input.photoId ?? 'photo-target',
    listLiveIncomingShares: async (requestedViewer) => {
      input.calls?.push(`list:${requestedViewer}`);
      return input.shares;
    },
    readLiveIncomingShare: async (requestedViewer, grantId) => {
      input.calls?.push(`share:${requestedViewer}:${grantId}`);
      return input.current?.has(grantId)
        ? input.current.get(grantId)
        : input.shares.find((share) => share.grantId === grantId);
    },
    readDocData: async (uid, kind, id) => {
      input.calls?.push(`doc:${uid}:${kind}:${id}`);
      return input.docs?.get(docKey(uid, kind, id));
    },
  };
}

describe('normalizeShareEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeShareEmail('  Alex@Example.com ')).toBe('alex@example.com');
    expect(normalizeShareEmail('')).toBeUndefined();
    expect(normalizeShareEmail('no-at')).toBeUndefined();
  });
});

describe('isSafeFirestoreDocumentId', () => {
  it('accepts unchanged document ids through the 1,500-byte UTF-8 limit', () => {
    expect(isSafeFirestoreDocumentId('viewer-123')).toBe(true);
    expect(isSafeFirestoreDocumentId('üser')).toBe(true);
    expect(isSafeFirestoreDocumentId('a'.repeat(1_500))).toBe(true);
    expect(isSafeFirestoreDocumentId('é'.repeat(750))).toBe(true);
  });

  it.each([
    undefined,
    '',
    ' viewer',
    'viewer ',
    'viewer/sub',
    '.',
    '..',
    '__viewer__',
    '__',
    'a'.repeat(1_501),
    'é'.repeat(751),
  ])('rejects unsafe document id %j', (candidate) => {
    expect(isSafeFirestoreDocumentId(candidate)).toBe(false);
  });
});

describe('queryShareProfileRows', () => {
  type StoredProfile = {
    sub: string;
    email: string;
    emailLower?: string;
    lastSeenAt: number;
  };

  function exactProfileQuery(
    profiles: StoredProfile[],
    calls: string[],
  ) {
    return async (field: 'emailLower' | 'email', email: string) => {
      calls.push(`${field}:${email}`);
      return profiles
        .filter((profile) => profile[field] === email)
        .map(({ sub, email: storedEmail, lastSeenAt }) => ({
          sub,
          email: storedEmail,
          lastSeenAt,
        }));
    };
  }

  it('uses emailLower first and does not fall back after a primary match', async () => {
    const calls: string[] = [];
    const rows = await queryShareProfileRows(
      'alex@example.com',
      exactProfileQuery(
        [
          {
            sub: 'new-profile',
            email: 'Alex@Example.com',
            emailLower: 'alex@example.com',
            lastSeenAt: 10,
          },
          {
            sub: 'legacy-profile',
            email: 'alex@example.com',
            lastSeenAt: 20,
          },
        ],
        calls,
      ),
    );

    expect(rows.map((row) => row.sub)).toEqual(['new-profile']);
    expect(calls).toEqual(['emailLower:alex@example.com']);
  });

  it('falls back to an exact normalized email for a lowercase legacy profile', async () => {
    const calls: string[] = [];
    const rows = await queryShareProfileRows(
      'legacy@example.com',
      exactProfileQuery(
        [
          {
            sub: 'legacy-profile',
            email: 'legacy@example.com',
            lastSeenAt: 10,
          },
        ],
        calls,
      ),
    );

    expect(rows.map((row) => row.sub)).toEqual(['legacy-profile']);
    expect(calls).toEqual([
      'emailLower:legacy@example.com',
      'email:legacy@example.com',
    ]);
  });

  it('cannot find a mixed-case legacy profile until emailLower is backfilled', async () => {
    const profile: StoredProfile = {
      sub: 'legacy-profile',
      email: 'Legacy@Example.com',
      lastSeenAt: 10,
    };
    const before = await queryShareProfileRows(
      'legacy@example.com',
      exactProfileQuery([profile], []),
    );
    expect(before).toEqual([]);

    profile.emailLower = 'legacy@example.com';
    const after = await queryShareProfileRows(
      'legacy@example.com',
      exactProfileQuery([profile], []),
    );
    expect(after.map((row) => row.sub)).toEqual(['legacy-profile']);
  });

  it('propagates primary and fallback query failures', async () => {
    await expect(
      queryShareProfileRows('target@example.com', async () => {
        throw new Error('primary unavailable');
      }),
    ).rejects.toThrow('primary unavailable');

    await expect(
      queryShareProfileRows('target@example.com', async (field) => {
        if (field === 'emailLower') {
          return [];
        }
        throw new Error('fallback unavailable');
      }),
    ).rejects.toThrow('fallback unavailable');
  });
});

describe('resolveShareTarget', () => {
  const base = {
    email: 'target@example.com',
    actorSub: 'actor',
    actorEmail: 'actor@example.com',
  };

  it('selects the latest profile and admits an active member', async () => {
    const memberReads: string[] = [];
    const target = await resolveShareTarget({
      ...base,
      queryUsers: async () => [
        { sub: 'older', email: 'target@example.com', lastSeenAt: 1 },
        { sub: 'latest', email: 'Target@Example.com', lastSeenAt: 9 },
      ],
      isOwnerEmail: () => false,
      readMemberStatus: async (sub) => {
        memberReads.push(sub);
        return 'active';
      },
    });

    expect(target).toEqual({
      kind: 'ok',
      sub: 'latest',
      email: 'Target@Example.com',
    });
    expect(memberReads).toEqual(['latest']);
  });

  it('rejects self by the selected profile sub', async () => {
    const target = await resolveShareTarget({
      ...base,
      queryUsers: async () => [
        { sub: 'actor', email: 'other@example.com', lastSeenAt: 1 },
      ],
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'active',
    });
    expect(target).toEqual({ kind: 'self' });
  });

  it('admits an owner without reading membership', async () => {
    let memberRead = false;
    const target = await resolveShareTarget({
      ...base,
      queryUsers: async () => [
        { sub: 'owner', email: 'Owner@Example.com', lastSeenAt: 1 },
      ],
      isOwnerEmail: (email) => email === 'Owner@Example.com',
      readMemberStatus: async () => {
        memberRead = true;
        return null;
      },
    });
    expect(target).toEqual({
      kind: 'ok',
      sub: 'owner',
      email: 'Owner@Example.com',
    });
    expect(memberRead).toBe(false);
  });

  it('keeps no match as notFound and query failure as unknown', async () => {
    const notFound = await resolveShareTarget({
      ...base,
      queryUsers: async () => [],
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'active',
    });
    expect(notFound).toEqual({ kind: 'notFound' });

    const unknown = await resolveShareTarget({
      ...base,
      queryUsers: async () => {
        throw new Error('query unavailable');
      },
      isOwnerEmail: () => false,
      readMemberStatus: async () => 'active',
    });
    expect(unknown).toEqual({ kind: 'unknown' });
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
      queryUsers: async () => [],
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
      queryUsers: async () => [
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
      queryUsers: async () => [{ sub: 'x', email: 'x@y.z', lastSeenAt: 1 }],
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
  it('distinguishes missing, live, and already-tombstoned grants', () => {
    expect(
      revokeGrantTransition({
        existing: null,
        viewerSub,
        now: 9,
      }),
    ).toEqual({ kind: 'missing' });

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
    const stored = { viewerSub, updatedAt: 4, deletedAt: 4 };
    expect(
      revokeGrantTransition({
        existing: stored,
        viewerSub,
        now: 9,
      }),
    ).toEqual({ kind: 'already', doc: stored });
  });
});

describe('orchestrateGrantRevoke', () => {
  function dependenciesFor(
    existing: LiveGrant | GrantTombstone | null,
    calls: string[],
    writes: Array<{ viewerSub: string; tombstone: GrantTombstone }>,
  ): RevokeGrantDependencies {
    return {
      runTransaction: async (work) => {
        calls.push('transaction');
        return work({
          readForwardGrant: async (requestedViewerSub) => {
            calls.push(`read:${requestedViewerSub}`);
            return existing;
          },
          writePair: async (requestedViewerSub, tombstone) => {
            calls.push(`write:${requestedViewerSub}`);
            writes.push({ viewerSub: requestedViewerSub, tombstone });
          },
        });
      },
    };
  }

  it('does not invoke a transaction, read, or write dependency for malformed input', async () => {
    for (const malformed of [
      '',
      ' viewer ',
      'viewer/sub',
      '.',
      '..',
      '__viewer__',
      'a'.repeat(1_501),
    ]) {
      const calls: string[] = [];
      const writes: Array<{
        viewerSub: string;
        tombstone: GrantTombstone;
      }> = [];
      await expect(
        orchestrateGrantRevoke(
          malformed,
          9,
          dependenciesFor(null, calls, writes),
        ),
      ).resolves.toEqual({ kind: 'badRequest' });
      expect(calls).toEqual([]);
      expect(writes).toEqual([]);
    }
  });

  it('reads the authoritative grant but does not write when it is missing', async () => {
    const calls: string[] = [];
    const writes: Array<{
      viewerSub: string;
      tombstone: GrantTombstone;
    }> = [];
    await expect(
      orchestrateGrantRevoke(
        viewerSub,
        9,
        dependenciesFor(null, calls, writes),
      ),
    ).resolves.toEqual({ kind: 'missing' });
    expect(calls).toEqual(['transaction', `read:${viewerSub}`]);
    expect(writes).toEqual([]);
  });

  it('returns the stored tombstone without a paired write', async () => {
    const calls: string[] = [];
    const writes: Array<{
      viewerSub: string;
      tombstone: GrantTombstone;
    }> = [];
    const stored = { viewerSub, updatedAt: 4, deletedAt: 4 };
    await expect(
      orchestrateGrantRevoke(
        viewerSub,
        9,
        dependenciesFor(stored, calls, writes),
      ),
    ).resolves.toEqual({ kind: 'already', doc: stored });
    expect(calls).toEqual(['transaction', `read:${viewerSub}`]);
    expect(writes).toEqual([]);
  });

  it('performs exactly one paired write for a live grant', async () => {
    const calls: string[] = [];
    const writes: Array<{
      viewerSub: string;
      tombstone: GrantTombstone;
    }> = [];
    const live: LiveGrant = {
      viewerSub,
      email: 'viewer@example.com',
      collectionId,
      createdAt: 1,
      updatedAt: 2,
    };
    await expect(
      orchestrateGrantRevoke(
        viewerSub,
        9,
        dependenciesFor(live, calls, writes),
      ),
    ).resolves.toEqual({
      kind: 'write',
      doc: { viewerSub, updatedAt: 9, deletedAt: 9 },
    });
    expect(calls).toEqual([
      'transaction',
      `read:${viewerSub}`,
      `write:${viewerSub}`,
    ]);
    expect(writes).toEqual([
      {
        viewerSub,
        tombstone: { viewerSub, updatedAt: 9, deletedAt: 9 },
      },
    ]);
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

describe('sessionCanViewOwnerPhoto', () => {
  it('allows live cover and gallery photos and bounds reads for an authorized first candidate', async () => {
    const shares = [
      { grantId: 'grant-a', ownerSub: 'owner', collectionId },
      {
        grantId: 'grant-b',
        ownerSub: 'owner',
        collectionId: secondCollectionId,
      },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, [recipeId]),
      ],
      [
        docKey('owner', 'photos', 'photo-cover'),
        livePhoto(recipeId),
      ],
      [
        docKey('owner', 'photos', 'photo-gallery'),
        { ...livePhoto(recipeId), id: 'photo-gallery' },
      ],
      [
        docKey('owner', 'recipes', recipeId),
        liveRecipe(recipeId, {
          photoId: 'photo-cover',
          galleryPhotoIds: ['photo-gallery'],
        }),
      ],
      [
        docKey('owner', 'collections', secondCollectionId),
        liveCollection(secondCollectionId, [secondRecipeId]),
      ],
      [
        docKey('owner', 'recipes', secondRecipeId),
        liveRecipe(secondRecipeId, { photoId: 'photo-cover' }),
      ],
    ]);
    const coverCalls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares,
          docs,
          calls: coverCalls,
          photoId: 'photo-cover',
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({ shares, docs, photoId: 'photo-gallery' }),
      ),
    ).resolves.toBe(true);
    expect(coverCalls[0]).toBe(`list:${viewerSub}`);
    expect(coverCalls).toContain(`share:${viewerSub}:grant-a`);
    expect(coverCalls).not.toContain(`share:${viewerSub}:grant-b`);
    expect(coverCalls).not.toContain(
      `doc:owner:collections:${secondCollectionId}`,
    );
    expect(coverCalls.filter((call) => call.startsWith('share:'))).toHaveLength(1);
    expect(
      coverCalls.filter((call) => call.includes(':collections:')),
    ).toHaveLength(1);
    expect(coverCalls.filter((call) => call.includes(':photos:'))).toHaveLength(1);
    expect(coverCalls.filter((call) => call.includes(':recipes:'))).toHaveLength(1);
  });

  it('denies a freshly revoked or changed share before owner reads', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    for (const current of [
      undefined,
      { ...share, collectionId: secondCollectionId },
    ]) {
      const calls: string[] = [];
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({
            shares: [share],
            current: new Map([['grant-a', current]]),
            calls,
          }),
        ),
      ).resolves.toBe(false);
      expect(calls).toEqual([
        `list:${viewerSub}`,
        `share:${viewerSub}:grant-a`,
      ]);
    }
  });

  it('denies through a missing, tombstoned, or mismatched collection without reading photo metadata', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const candidates = [
      undefined,
      { ...liveCollection(collectionId, [recipeId]), deletedAt: 3 },
      liveCollection(secondCollectionId, [recipeId]),
    ];
    for (const collection of candidates) {
      const calls: string[] = [];
      const docs = new Map<string, Record<string, unknown> | undefined>([
        [docKey('owner', 'collections', collectionId), collection],
      ]);
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, calls }),
        ),
      ).resolves.toBe(false);
      expect(calls.some((call) => call.includes(':photos:'))).toBe(false);
      expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
    }
  });

  it('denies missing, tombstoned, non-live, or invalid-parent photo metadata before a recipe read', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const candidates = [
      undefined,
      { ...livePhoto(recipeId), deletedAt: 3 },
      { ...livePhoto(recipeId), status: 'uploading' },
      livePhoto('not-a-valid-recipe-id'),
    ];
    for (const photo of candidates) {
      const calls: string[] = [];
      const docs = new Map<string, Record<string, unknown> | undefined>([
        [
          docKey('owner', 'collections', collectionId),
          liveCollection(collectionId, [recipeId]),
        ],
        [docKey('owner', 'photos', 'photo-target'), photo],
      ]);
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, calls }),
        ),
      ).resolves.toBe(false);
      expect(calls.filter((call) => call.includes(':photos:'))).toHaveLength(1);
      expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
    }
  });

  it('denies a missing or tombstoned recipe and a recipe removed from the collection', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const candidates = [
      {
        collection: liveCollection(collectionId, [recipeId]),
        recipe: undefined,
      },
      {
        collection: liveCollection(collectionId, [recipeId]),
        recipe: {
          ...liveRecipe(recipeId, { photoId: 'photo-target' }),
          deletedAt: 3,
        },
      },
      {
        collection: liveCollection(collectionId, [secondRecipeId]),
        recipe: liveRecipe(recipeId, { photoId: 'photo-target' }),
      },
    ];
    for (const candidate of candidates) {
      const calls: string[] = [];
      const docs = new Map<string, Record<string, unknown> | undefined>([
        [docKey('owner', 'collections', collectionId), candidate.collection],
        [docKey('owner', 'photos', 'photo-target'), livePhoto(recipeId)],
        [docKey('owner', 'recipes', recipeId), candidate.recipe],
      ]);
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, calls }),
        ),
      ).resolves.toBe(false);
      expect(calls.filter((call) => call.includes(':recipes:'))).toHaveLength(1);
    }
  });

  it('denies unrelated owner photos and chat attachments despite parent metadata', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, [recipeId]),
      ],
      [
        docKey('owner', 'recipes', recipeId),
        liveRecipe(recipeId, {
          photoId: 'photo-cover',
          galleryPhotoIds: ['photo-gallery'],
        }),
      ],
      [
        docKey('owner', 'photos', 'photo-unrelated'),
        { ...livePhoto(recipeId), id: 'photo-unrelated' },
      ],
      [
        docKey('owner', 'photos', 'photo-chat'),
        { ...livePhoto(recipeId), id: 'photo-chat' },
      ],
    ]);
    for (const photoId of ['photo-unrelated', 'photo-chat']) {
      await expect(
        sessionCanViewOwnerPhoto(
          photoAccessInput({ shares: [share], docs, photoId }),
        ),
      ).resolves.toBe(false);
    }
  });
});
