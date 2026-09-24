import { describe, expect, it } from 'vitest';
import type { LiveIncomingShare } from './grants.ts';
import {
  buildSharedPullPage,
  decodeSharedCursor,
  encodeSharedCursor,
  type BuildSharedPullPageInput,
  type SharedCursor,
} from './sharedPull.ts';
import type { StoreKind } from './store.ts';

const viewerSub = 'viewer';
const collectionA = '11111111-1111-4111-8111-111111111111';
const collectionB = '22222222-2222-4222-8222-222222222222';

function liveCollection(id: string, recipeIds: string[]) {
  return {
    id,
    name: `Collection ${id}`,
    recipeIds,
    createdAt: 1,
    updatedAt: 2,
  };
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

function pageInput(input: {
  shares: LiveIncomingShare[];
  current?: Map<string, LiveIncomingShare | undefined>;
  docs?: Map<string, Record<string, unknown> | undefined>;
  cursor?: SharedCursor;
  limit?: number;
  calls?: string[];
}): BuildSharedPullPageInput {
  return {
    viewerSub,
    cursor: input.cursor ?? { grantId: '', recipeId: '' },
    limit: input.limit ?? 200,
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

describe('shared pull cursor', () => {
  it('round-trips a grant id that is not a UUID', () => {
    const cursor = { grantId: 'google-sub_11111111-1111-4111-8111-111111111111', recipeId: '' };
    expect(decodeSharedCursor(encodeSharedCursor(cursor))).toEqual(cursor);
  });

  it('treats junk as the start of the keyspace', () => {
    expect(decodeSharedCursor(null)).toEqual({ grantId: '', recipeId: '' });
    expect(decodeSharedCursor('%%%')).toEqual({ grantId: '', recipeId: '' });
  });
});

describe('buildSharedPullPage', () => {
  it('paginates sorted recipes without gaps and then advances to the next grant', async () => {
    const shares = [
      { grantId: 'grant-a', ownerSub: 'owner-a', collectionId: collectionA },
      { grantId: 'grant-b', ownerSub: 'owner-b', collectionId: collectionB },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-3', 'recipe-1', 'recipe-2']),
      ],
      [
        docKey('owner-b', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-4']),
      ],
      ...['recipe-1', 'recipe-2', 'recipe-3'].map(
        (id) =>
          [
            docKey('owner-a', 'recipes', id),
            liveRecipe(id),
          ] as [string, Record<string, unknown>],
      ),
      [docKey('owner-b', 'recipes', 'recipe-4'), liveRecipe('recipe-4')],
    ]);

    const first = await buildSharedPullPage(
      pageInput({ shares, docs, limit: 2 }),
    );
    const second = await buildSharedPullPage(
      pageInput({ shares, docs, limit: 2, cursor: first.cursor }),
    );
    const third = await buildSharedPullPage(
      pageInput({ shares, docs, limit: 2, cursor: second.cursor }),
    );

    expect(first.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-1',
      'recipe-2',
    ]);
    expect(first.cursor).toEqual({
      grantId: 'grant-a',
      recipeId: 'recipe-2',
    });
    expect(first.hasMore).toBe(true);
    expect(second.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-3',
    ]);
    expect(second.cursor).toEqual({ grantId: 'grant-a', recipeId: '\uFFFF' });
    expect(second.hasMore).toBe(true);
    expect(third.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-4',
    ]);
    expect(third.cursor).toEqual({ grantId: 'grant-b', recipeId: '\uFFFF' });
    expect(third.hasMore).toBe(false);
    expect(
      [first, second, third].flatMap((page) =>
        page.changes.recipes.map((recipe) => recipe.id),
      ),
    ).toEqual(['recipe-1', 'recipe-2', 'recipe-3', 'recipe-4']);
    expect(first.changes.collections).toHaveLength(1);
    expect(second.changes.collections).toHaveLength(1);
    expect(third.changes.collections).toHaveLength(1);
  });

  it('revalidates listed shares and skips revoked or changed rows before owner reads', async () => {
    const shares = [
      {
        grantId: 'grant-revoked',
        ownerSub: 'owner-revoked',
        collectionId: collectionA,
      },
      {
        grantId: 'grant-changed',
        ownerSub: 'owner-old',
        collectionId: collectionA,
      },
      {
        grantId: 'grant-live',
        ownerSub: 'owner-live',
        collectionId: collectionB,
      },
    ];
    const current = new Map<string, LiveIncomingShare | undefined>([
      ['grant-revoked', undefined],
      [
        'grant-changed',
        {
          grantId: 'grant-changed',
          ownerSub: 'owner-new',
          collectionId: collectionB,
        },
      ],
      ['grant-live', shares[2]],
    ]);
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-live', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-live']),
      ],
      [
        docKey('owner-live', 'recipes', 'recipe-live'),
        liveRecipe('recipe-live'),
      ],
    ]);
    const calls: string[] = [];

    const result = await buildSharedPullPage(
      pageInput({ shares, current, docs, calls }),
    );

    expect(calls[0]).toBe(`list:${viewerSub}`);
    expect(calls).toContain(`share:${viewerSub}:grant-revoked`);
    expect(calls).toContain(`share:${viewerSub}:grant-changed`);
    expect(calls).not.toContain(
      `doc:owner-revoked:collections:${collectionA}`,
    );
    expect(calls).not.toContain(`doc:owner-old:collections:${collectionA}`);
    expect(result.changes.collections).toEqual([
      expect.objectContaining({ id: collectionB, ownerSub: 'owner-live' }),
    ]);
    expect(result.changes.recipes).toEqual([
      expect.objectContaining({ id: 'recipe-live', ownerSub: 'owner-live' }),
    ]);
    expect(result.cursor.grantId).toBe('grant-live');
  });

  it('emits nothing through a tombstoned collection', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        {
          ...liveCollection(collectionA, ['recipe-a']),
          deletedAt: 3,
        },
      ],
      [docKey('owner-a', 'recipes', 'recipe-a'), liveRecipe('recipe-a')],
      [
        docKey('owner-a', 'photos', 'photo-a'),
        { contentType: 'image/jpeg', size: 1, createdAt: 1, updatedAt: 1 },
      ],
    ]);
    const calls: string[] = [];

    const result = await buildSharedPullPage(
      pageInput({ shares: [share], docs, calls }),
    );

    expect(result.changes).toEqual({
      collections: [],
      recipes: [],
      photos: [],
    });
    expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
    expect(calls.some((call) => call.includes(':photos:'))).toBe(false);
  });

  it('skips removed, tombstoned, and missing recipes while advancing examined ids', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, [
          'recipe-a-tombstone',
          'recipe-b-missing',
          'recipe-c-live',
        ]),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-a-tombstone'),
        { ...liveRecipe('recipe-a-tombstone'), deletedAt: 3 },
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-c-live'),
        liveRecipe('recipe-c-live'),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-removed'),
        liveRecipe('recipe-removed'),
      ],
    ]);
    const calls: string[] = [];

    const first = await buildSharedPullPage(
      pageInput({ shares: [share], docs, calls, limit: 1 }),
    );
    const second = await buildSharedPullPage(
      pageInput({
        shares: [share],
        docs,
        calls,
        limit: 1,
        cursor: first.cursor,
      }),
    );
    const third = await buildSharedPullPage(
      pageInput({
        shares: [share],
        docs,
        calls,
        limit: 1,
        cursor: second.cursor,
      }),
    );

    expect(first.changes.recipes).toEqual([]);
    expect(first.cursor.recipeId).toBe('recipe-a-tombstone');
    expect(first.hasMore).toBe(true);
    expect(second.changes.recipes).toEqual([]);
    expect(second.cursor.recipeId).toBe('recipe-b-missing');
    expect(second.hasMore).toBe(true);
    expect(third.changes.recipes).toEqual([
      expect.objectContaining({ id: 'recipe-c-live' }),
    ]);
    expect(calls).not.toContain('doc:owner-a:recipes:recipe-removed');
  });

  it('emits metadata only for authorized recipe photo references', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-a']),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-a'),
        liveRecipe('recipe-a', {
          photoId: 'photo-cover',
          galleryPhotoIds: ['photo-cover', 'photo-gallery'],
        }),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-unrelated'),
        liveRecipe('recipe-unrelated', { photoId: 'photo-unrelated' }),
      ],
      ...['photo-cover', 'photo-gallery', 'photo-unrelated'].map(
        (id) =>
          [
            docKey('owner-a', 'photos', id),
            {
              contentType: 'image/jpeg',
              size: id.length,
              createdAt: 1,
              updatedAt: 1,
            },
          ] as [string, Record<string, unknown>],
      ),
      [
        docKey('owner-other', 'photos', 'photo-cover'),
        { contentType: 'image/png', size: 999, createdAt: 1, updatedAt: 1 },
      ],
    ]);
    const calls: string[] = [];

    const result = await buildSharedPullPage(
      pageInput({ shares: [share], docs, calls }),
    );

    expect(result.changes.photos.map((photo) => photo.id)).toEqual([
      'photo-cover',
      'photo-gallery',
    ]);
    expect(calls).not.toContain('doc:owner-a:photos:photo-unrelated');
    expect(calls).not.toContain('doc:owner-other:photos:photo-cover');
  });

  it('does not let a hostile cursor manufacture an owner-tree read', async () => {
    const allowedShare = {
      grantId: 'grant-a',
      ownerSub: 'owner-allowed',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-allowed', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-allowed']),
      ],
      [
        docKey('owner-allowed', 'recipes', 'recipe-allowed'),
        liveRecipe('recipe-allowed'),
      ],
      [
        docKey('owner-secret', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-secret']),
      ],
      [
        docKey('owner-secret', 'recipes', 'recipe-secret'),
        liveRecipe('recipe-secret'),
      ],
    ]);
    const calls: string[] = [];

    const result = await buildSharedPullPage(
      pageInput({
        shares: [allowedShare],
        docs,
        calls,
        cursor: { grantId: 'grant-0-hostile', recipeId: 'recipe-secret' },
      }),
    );

    expect(result.changes.recipes).toEqual([
      expect.objectContaining({
        id: 'recipe-allowed',
        ownerSub: 'owner-allowed',
      }),
    ]);
    expect(calls.some((call) => call.includes('owner-secret'))).toBe(false);
  });
});
