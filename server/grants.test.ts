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
  sessionCanViewOwnerPhoto,
  shareGrantId,
  type LiveIncomingShare,
  type SessionCanViewOwnerPhotoInput,
} from './grants.ts';
import type { StoreKind } from './store.ts';

const viewerSub = 'viewer-1';
const collectionId = '11111111-1111-4111-8111-111111111111';
const secondCollectionId = '22222222-2222-4222-8222-222222222222';

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

describe('sessionCanViewOwnerPhoto', () => {
  it('allows listed live cover and gallery photos and stops at the first authorized share', async () => {
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
        liveCollection(collectionId, ['recipe-a']),
      ],
      [
        docKey('owner', 'recipes', 'recipe-a'),
        liveRecipe('recipe-a', {
          photoId: 'photo-cover',
          galleryPhotoIds: ['photo-gallery'],
        }),
      ],
      [
        docKey('owner', 'collections', secondCollectionId),
        liveCollection(secondCollectionId, ['recipe-b']),
      ],
      [
        docKey('owner', 'recipes', 'recipe-b'),
        liveRecipe('recipe-b', { photoId: 'photo-cover' }),
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
  });

  it('denies a candidate revoked by fresh revalidation before owner reads', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const calls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares: [share],
          current: new Map([['grant-a', undefined]]),
          calls,
        }),
      ),
    ).resolves.toBe(false);
    expect(calls).toEqual([
      `list:${viewerSub}`,
      `share:${viewerSub}:grant-a`,
    ]);
  });

  it('denies photos through a tombstoned collection', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        {
          ...liveCollection(collectionId, ['recipe-a']),
          deletedAt: 3,
        },
      ],
      [
        docKey('owner', 'recipes', 'recipe-a'),
        liveRecipe('recipe-a', { photoId: 'photo-target' }),
      ],
    ]);
    const calls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({ shares: [share], docs, calls }),
      ),
    ).resolves.toBe(false);
    expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
  });

  it('denies a recipe removed from the collection and a tombstoned recipe', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const removedDocs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, ['recipe-listed']),
      ],
      [
        docKey('owner', 'recipes', 'recipe-listed'),
        liveRecipe('recipe-listed', { photoId: 'photo-other' }),
      ],
      [
        docKey('owner', 'recipes', 'recipe-removed'),
        liveRecipe('recipe-removed', { photoId: 'photo-target' }),
      ],
    ]);
    const removedCalls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares: [share],
          docs: removedDocs,
          calls: removedCalls,
        }),
      ),
    ).resolves.toBe(false);
    expect(removedCalls).not.toContain('doc:owner:recipes:recipe-removed');

    const tombstonedDocs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, ['recipe-a']),
      ],
      [
        docKey('owner', 'recipes', 'recipe-a'),
        {
          ...liveRecipe('recipe-a', { photoId: 'photo-target' }),
          deletedAt: 3,
        },
      ],
    ]);
    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({ shares: [share], docs: tombstonedDocs }),
      ),
    ).resolves.toBe(false);
  });

  it('does not authorize from another owner or an unrelated requested-owner photo doc', async () => {
    const shares = [
      {
        grantId: 'grant-other',
        ownerSub: 'owner-other',
        collectionId: secondCollectionId,
      },
      { grantId: 'grant-owner', ownerSub: 'owner', collectionId },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-other', 'collections', secondCollectionId),
        liveCollection(secondCollectionId, ['recipe-other']),
      ],
      [
        docKey('owner-other', 'recipes', 'recipe-other'),
        liveRecipe('recipe-other', { photoId: 'photo-target' }),
      ],
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, ['recipe-owner']),
      ],
      [
        docKey('owner', 'recipes', 'recipe-owner'),
        liveRecipe('recipe-owner', { photoId: 'photo-different' }),
      ],
      [
        docKey('owner', 'photos', 'photo-target'),
        { contentType: 'image/jpeg', size: 10, createdAt: 1, updatedAt: 1 },
      ],
    ]);
    const calls: string[] = [];

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({ shares, docs, calls }),
      ),
    ).resolves.toBe(false);
    expect(calls).not.toContain(
      `doc:owner-other:collections:${secondCollectionId}`,
    );
    expect(calls).not.toContain('doc:owner:photos:photo-target');
  });

  it('denies chat and otherwise unreferenced photo ids', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner', collectionId };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner', 'collections', collectionId),
        liveCollection(collectionId, ['recipe-a']),
      ],
      [
        docKey('owner', 'recipes', 'recipe-a'),
        liveRecipe('recipe-a', { photoId: 'photo-cover' }),
      ],
      [
        docKey('owner', 'photos', 'chat-photo'),
        { contentType: 'image/jpeg', size: 10, createdAt: 1, updatedAt: 1 },
      ],
    ]);

    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares: [share],
          docs,
          photoId: 'chat-photo',
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      sessionCanViewOwnerPhoto(
        photoAccessInput({
          shares: [share],
          docs,
          photoId: 'photo-unreferenced',
        }),
      ),
    ).resolves.toBe(false);
  });
});
