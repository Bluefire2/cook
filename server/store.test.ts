import { describe, expect, it } from 'vitest';
import {
  COOK_LOG_CASES,
  FULL_COOK_LOG,
  FULL_COOK_LOG_UNCOMPACTED,
  MINIMAL_COOK_LOG,
  MINIMAL_COOK_LOG_UNCOMPACTED,
} from '../test/cookLogFixtures.ts';
import {
  cascadeChildJobs,
  cascadeJobCost,
  cascadeTombstoneAt,
  compactCookLogFields,
  cookLogMovesRecipe,
  forcedTombstoneAt,
  isCookedOn,
  validateCookLogDelete,
  validateCookLogPut,
  addedCollectionRecipeIds,
  chunkByCost,
  chunkForBatch,
  applyCollectionMembershipScrubs,
  collectionDocsFromQuerySnap,
  collectionsToScrub,
  chatCookPullFields,
  chatOrCookPutBody,
  collectionDeletePayload,
  compactCollectionFields,
  compactRecipeFields,
  MAX_RECIPE_LANG_CHARS,
  compareMutation,
  SHARED_PARENT_OWNER_SUB_FIELD,
  sharedParentMarkerForWrite,
  sharedParentOwnerFromCandidate,
  findSharedParentOwner,
  storedSharedParentOwner,
  type SharedParentLookupIo,
  recipeIdsWithoutTombstones,
  createListLiveDocsAccumulator,
  decodePullCursor,
  encodePullCursor,
  foldListLiveDocsCandidate,
  isUuid,
  messageIdsToClearAtBoundary,
  tombstoneChatChunk,
  emailLowerBackfill,
  userProfileUpsertFields,
  validatePushOp,
  isKnownPushKind,
} from './store.ts';
import { translationCacheDocIds } from './recipeTranslation.ts';

describe('emailLowerBackfill', () => {
  it('returns the normalized address when emailLower is missing or stale', () => {
    expect(emailLowerBackfill({ email: 'Mixed.Case@Example.com' })).toBe(
      'mixed.case@example.com',
    );
    expect(
      emailLowerBackfill({ email: 'New@Example.com', emailLower: 'old@example.com' }),
    ).toBe('new@example.com');
  });

  it('skips profiles that already match or have no usable email', () => {
    expect(
      emailLowerBackfill({ email: 'A@Example.com', emailLower: 'a@example.com' }),
    ).toBeNull();
    expect(emailLowerBackfill({})).toBeNull();
    expect(emailLowerBackfill({ email: '  ' })).toBeNull();
    expect(emailLowerBackfill({ email: 42 })).toBeNull();
  });
});

describe('userProfileUpsertFields', () => {
  it('derives emailLower while preserving the original email and name', () => {
    expect(
      userProfileUpsertFields(
        { email: '  Alex@Example.COM ', name: 'Alex Example' },
        123,
        true,
      ),
    ).toEqual({
      email: '  Alex@Example.COM ',
      emailLower: 'alex@example.com',
      name: 'Alex Example',
      lastSeenAt: 123,
      createdAt: 123,
    });
  });

  it('keeps existing merge semantics for an omitted name and createdAt', () => {
    expect(
      userProfileUpsertFields({ email: 'alex@example.com' }, 456, false),
    ).toEqual({
      email: 'alex@example.com',
      emailLower: 'alex@example.com',
      lastSeenAt: 456,
    });
  });
});

describe('compareMutation', () => {
  it('rejects stale puts', () => {
    expect(
      compareMutation({ updatedAt: 10 }, 5, 'put'),
    ).toEqual({ allow: false, reason: 'stale' });
  });

  it('allows equal-timestamp idempotent puts on live docs', () => {
    expect(compareMutation({ updatedAt: 5 }, 5, 'put')).toEqual({
      allow: true,
      undeleting: false,
    });
  });

  it('tombstone wins against put at equal timestamp', () => {
    expect(
      compareMutation({ updatedAt: 5, deletedAt: 5 }, 5, 'put'),
    ).toEqual({ allow: false, reason: 'already-deleted' });
  });

  it('allows un-delete only when client is strictly newer', () => {
    expect(
      compareMutation({ updatedAt: 5, deletedAt: 5 }, 6, 'put'),
    ).toEqual({ allow: true, undeleting: true });
  });

  it('rejects stale tombstones', () => {
    expect(
      compareMutation({ updatedAt: 10 }, 5, 'tombstone'),
    ).toEqual({ allow: false, reason: 'stale' });
  });
});

describe('pull cursor', () => {
  it('round-trips per-collection cursors', () => {
    const cursor = {
      recipes: [100, '11111111-1111-4111-8111-111111111111'] as [number, string],
      collections: [200, '22222222-2222-4222-8222-222222222222'] as [number, string],
    };
    const encoded = encodePullCursor(cursor);
    expect(decodePullCursor(encoded)).toEqual(cursor);
  });

  it('treats garbage as empty', () => {
    expect(decodePullCursor('not-json')).toEqual({});
  });

  it('keeps the cookLogs cursor and drops unknown kinds', () => {
    const cookLogs: [number, string] = [300, '33333333-3333-4333-8333-333333333333'];
    const encoded = Buffer.from(
      JSON.stringify({ cookLogs, somethingNew: [1, '44444444-4444-4444-8444-444444444444'] }),
      'utf8',
    ).toString('base64url');
    expect(decodePullCursor(encoded)).toEqual({ cookLogs });
  });
});

describe('chunkForBatch', () => {
  it('splits into chunks of at most maxSize', () => {
    expect(chunkForBatch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('chunkByCost', () => {
  it('keeps photo tombstone+gcsDeletes pairs under the write cap', () => {
    const jobs = [
      { kind: 'chatMessages' },
      { kind: 'photos' },
      { kind: 'photos' },
    ];
    expect(
      chunkByCost(jobs, (job) => (job.kind === 'photos' ? 2 : 1), 3),
    ).toEqual([
      [{ kind: 'chatMessages' }, { kind: 'photos' }],
      [{ kind: 'photos' }],
    ]);
  });
});

describe('validatePushOp', () => {
  it('accepts a minimal recipe.put', () => {
    const result = validatePushOp({
      kind: 'recipe.put',
      payload: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'T',
        servings: 1,
        ingredientSections: [],
        steps: [],
        tags: [],
        createdAt: 1,
        updatedAt: 2,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown kinds via caller', () => {
    expect(validatePushOp({ kind: 'photo.put', payload: {} }).ok).toBe(false);
  });

  it('accepts recipe.put with up to 8 gallery UUIDs', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const galleryPhotoIds = Array.from({ length: 8 }, (_, i) =>
      `11111111-1111-4111-8111-11111111111${i}`,
    );
    expect(
      validatePushOp({
        kind: 'recipe.put',
        payload: {
          id,
          title: 'T',
          servings: 1,
          ingredientSections: [],
          steps: [],
          tags: [],
          createdAt: 1,
          updatedAt: 2,
          galleryPhotoIds,
        },
      }).ok,
    ).toBe(true);
  });

  it('rejects a non-string or oversized lang and accepts anything shorter', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'T',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 2,
    };
    expect(validatePushOp({ kind: 'recipe.put', payload: { ...base, lang: 'it' } }).ok).toBe(true);
    expect(validatePushOp({ kind: 'recipe.put', payload: { ...base, lang: 'garbage!!' } }).ok).toBe(
      true,
    );
    expect(
      validatePushOp({
        kind: 'recipe.put',
        payload: { ...base, lang: 'x'.repeat(MAX_RECIPE_LANG_CHARS) },
      }).ok,
    ).toBe(true);
    expect(
      validatePushOp({
        kind: 'recipe.put',
        payload: { ...base, lang: 'x'.repeat(MAX_RECIPE_LANG_CHARS + 1) },
      }).ok,
    ).toBe(false);
    expect(validatePushOp({ kind: 'recipe.put', payload: { ...base, lang: 1 } }).ok).toBe(false);
    expect(validatePushOp({ kind: 'recipe.put', payload: { ...base, lang: null } }).ok).toBe(false);
    expect(validatePushOp({ kind: 'recipe.put', payload: { ...base, lang: ['it'] } }).ok).toBe(
      false,
    );
  });

  it('rejects recipe.put with more than 8 gallery photos or a non-UUID', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const base = {
      id,
      title: 'T',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const nine = Array.from({ length: 9 }, () => id);
    expect(
      validatePushOp({ kind: 'recipe.put', payload: { ...base, galleryPhotoIds: nine } }).ok,
    ).toBe(false);
    expect(
      validatePushOp({
        kind: 'recipe.put',
        payload: { ...base, galleryPhotoIds: ['not-a-uuid'] },
      }).ok,
    ).toBe(false);
  });

  it('accepts a minimal collection.put', () => {
    expect(
      validatePushOp({
        kind: 'collection.put',
        payload: {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Dinners',
          recipeIds: [],
          createdAt: 1,
          updatedAt: 2,
        },
      }).ok,
    ).toBe(true);
  });

  it('rejects collection.put with an empty name, overlong name, or non-UUID recipe id', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const base = { id, name: 'Dinners', recipeIds: [], createdAt: 1, updatedAt: 2 };
    expect(validatePushOp({ kind: 'collection.put', payload: { ...base, name: '  ' } }).ok).toBe(
      false,
    );
    expect(
      validatePushOp({ kind: 'collection.put', payload: { ...base, name: 'x'.repeat(81) } }).ok,
    ).toBe(false);
    expect(
      validatePushOp({
        kind: 'collection.put',
        payload: { ...base, recipeIds: ['not-a-uuid'] },
      }).ok,
    ).toBe(false);
    const tooMany = Array.from({ length: 501 }, () => id);
    expect(
      validatePushOp({ kind: 'collection.put', payload: { ...base, recipeIds: tooMany } }).ok,
    ).toBe(false);
  });

  it('accepts collection.delete', () => {
    expect(
      validatePushOp({
        kind: 'collection.delete',
        payload: { id: '11111111-1111-4111-8111-111111111111', updatedAt: 3 },
      }).ok,
    ).toBe(true);
  });
});

describe('collectionDeletePayload', () => {
  it('keeps the client clock and stores grantCascadeAt separately', () => {
    expect(collectionDeletePayload('c1', 100, 80, 251)).toEqual({
      id: 'c1',
      updatedAt: 100,
      deletedAt: 100,
      serverUpdatedAt: 80,
      grantCascadeAt: 251,
    });
    expect(collectionDeletePayload('c1', 100, 80)).not.toHaveProperty('grantCascadeAt');
  });
});

describe('compactCollectionFields', () => {
  it('omits internal grantCascadeAt from the client collection', () => {
    expect(
      compactCollectionFields({
        id: 'c1',
        name: 'Dinners',
        recipeIds: [],
        createdAt: 1,
        updatedAt: 2,
        grantCascadeAt: 251,
        serverUpdatedAt: 80,
      }),
    ).toEqual({
      id: 'c1',
      name: 'Dinners',
      recipeIds: [],
      createdAt: 1,
      updatedAt: 2,
    });
  });
});

describe('compactRecipeFields', () => {
  const required = {
    id: 'r1',
    createdAt: 1,
    updatedAt: 2,
    title: 'Soup',
    servings: 4,
    ingredientSections: [],
    steps: [],
    tags: [],
  };

  it('keeps galleryPhotoIds when present', () => {
    const compacted = compactRecipeFields({
      ...required,
      galleryPhotoIds: ['g1', 'g2'],
    });
    expect(compacted.galleryPhotoIds).toEqual(['g1', 'g2']);
  });

  it('normalizes lang and omits a value it cannot understand', () => {
    expect(compactRecipeFields({ ...required, lang: 'it-IT' }).lang).toBe('it');
    expect(compactRecipeFields({ ...required, lang: 'ua' }).lang).toBe('uk');
    expect(compactRecipeFields({ ...required, lang: 'zh-CN' }).lang).toBe('zh-Hans');
    expect(compactRecipeFields({ ...required, lang: 'garbage!!' })).not.toHaveProperty('lang');
    expect(compactRecipeFields({ ...required, lang: 4 })).not.toHaveProperty('lang');
    expect(
      compactRecipeFields({ ...required, lang: 'x'.repeat(MAX_RECIPE_LANG_CHARS) }),
    ).not.toHaveProperty('lang');
  });

  it('omits an empty gallery and strips the cover id', () => {
    expect(
      compactRecipeFields({ ...required, photoId: 'p1', galleryPhotoIds: [] }),
    ).not.toHaveProperty('galleryPhotoIds');
    expect(
      compactRecipeFields({
        ...required,
        photoId: 'p1',
        galleryPhotoIds: ['p1', 'g1', 'g1'],
      }).galleryPhotoIds,
    ).toEqual(['g1']);
  });
});

describe('recipeIdsWithoutTombstones', () => {
  const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const goneId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const missingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('drops tombstoned recipe ids and keeps live and missing ones', () => {
    expect(
      recipeIdsWithoutTombstones(
        [liveId, goneId, missingId],
        new Set([goneId]),
      ),
    ).toEqual([liveId, missingId]);
  });

  it('keeps every id not known to be tombstoned', () => {
    expect(recipeIdsWithoutTombstones([liveId, goneId], new Set())).toEqual([
      liveId,
      goneId,
    ]);
  });
});

describe('addedCollectionRecipeIds', () => {
  const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const added = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('checks only ids newly added to a live collection', () => {
    const existing = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'Dinners',
      recipeIds: [first, second],
      createdAt: 1,
      updatedAt: 2,
    };
    expect(addedCollectionRecipeIds(existing, [second, first])).toEqual([]);
    expect(addedCollectionRecipeIds(existing, [first, second, added])).toEqual([
      added,
    ]);
  });

  it('checks every id for a new or tombstoned collection', () => {
    expect(addedCollectionRecipeIds(undefined, [first, added])).toEqual([
      first,
      added,
    ]);
    expect(
      addedCollectionRecipeIds(
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          updatedAt: 3,
          deletedAt: 3,
        },
        [first, added],
      ),
    ).toEqual([first, added]);
  });
});

describe('compactCollectionFields', () => {
  it('trims the name and unique-ifies recipeIds', () => {
    expect(
      compactCollectionFields({
        id: 'c1',
        name: '  Dinners  ',
        recipeIds: ['a', 'a', 'b'],
        createdAt: 1,
        updatedAt: 2,
        extra: true,
      }),
    ).toEqual({
      id: 'c1',
      name: 'Dinners',
      recipeIds: ['a', 'b'],
      createdAt: 1,
      updatedAt: 2,
    });
  });
});

describe('collectionsToScrub', () => {
  const recipeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('drops the recipe id from a live collection that lists it', () => {
    expect(
      collectionsToScrub(
        [
          {
            id: 'c1',
            name: 'Dinners',
            recipeIds: [recipeId, otherId],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        recipeId,
        10,
      ),
    ).toEqual([
      {
        id: 'c1',
        name: 'Dinners',
        recipeIds: [otherId],
        createdAt: 1,
        updatedAt: 10,
      },
    ]);
  });

  it('skips tombstones and docs that do not list the id', () => {
    expect(
      collectionsToScrub(
        [
          {
            id: 'tomb',
            name: 'Gone',
            recipeIds: [recipeId],
            createdAt: 1,
            updatedAt: 2,
            deletedAt: 2,
          },
          {
            id: 'other',
            name: 'Other',
            recipeIds: [otherId],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        recipeId,
        10,
      ),
    ).toEqual([]);
  });

  it('still drops the id from a collection edited after the delete', () => {
    expect(
      collectionsToScrub(
        [
          {
            id: 'newer',
            name: 'Renamed',
            recipeIds: [recipeId, otherId],
            createdAt: 1,
            updatedAt: 20,
          },
        ],
        recipeId,
        10,
      ),
    ).toEqual([
      {
        id: 'newer',
        name: 'Renamed',
        recipeIds: [otherId],
        createdAt: 1,
        updatedAt: 20,
      },
    ]);
  });
});

describe('collection membership cascade glue', () => {
  const recipeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('maps query snapshots with the document id winning over data.id', () => {
    expect(
      collectionDocsFromQuerySnap([
        {
          id: 'from-path',
          data: () => ({
            id: 'from-body',
            name: 'Dinners',
            recipeIds: [recipeId],
            createdAt: 1,
            updatedAt: 2,
          }),
        },
      ]),
    ).toEqual([
      {
        id: 'from-path',
        name: 'Dinners',
        recipeIds: [recipeId],
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
  });

  it('writes each scrub with the payload timestamp, not the delete time', async () => {
    const writes: Array<{ id: string; writeAt: number; recipeIds: unknown }> = [];
    await applyCollectionMembershipScrubs(
      [
        {
          id: 'c1',
          name: 'Dinners',
          recipeIds: [recipeId],
          createdAt: 1,
          updatedAt: 20,
        },
      ],
      recipeId,
      10,
      async (id, payload, writeAt) => {
        writes.push({ id, writeAt, recipeIds: payload.recipeIds });
      },
    );
    expect(writes).toEqual([{ id: 'c1', writeAt: 20, recipeIds: [] }]);
  });
});

describe('messageIdsToClearAtBoundary', () => {
  it('includes messages at exactly createdAt === at', () => {
    const ids = messageIdsToClearAtBoundary(
      [
        { id: 'a', createdAt: 10 },
        { id: 'b', createdAt: 11 },
      ],
      10,
    );
    expect(ids).toEqual(['a']);
  });
});

describe('tombstoneChatChunk', () => {
  const READ_AFTER_WRITE =
    'Firestore transactions require all reads to be executed before all writes.';

  function transaction(docs: Record<string, Record<string, unknown> | undefined>) {
    const order: string[] = [];
    const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
    let written = false;
    return {
      order,
      writes,
      async getAll(...refs: { id: string }[]) {
        if (written) {
          throw new Error(READ_AFTER_WRITE);
        }
        order.push('read');
        return refs.map((ref) => {
          const data = docs[ref.id];
          return {
            exists: data !== undefined,
            data: () => data,
          };
        });
      },
      set(ref: { id: string }, data: Record<string, unknown>, options: { merge: false }) {
        written = true;
        order.push('write');
        writes.push({ id: ref.id, data, ...options });
      },
    };
  }

  it('reads every message before writing, including a thread of two', async () => {
    const tx = transaction({
      user: { updatedAt: 1, content: 'Can I use honey?' },
      assistant: { updatedAt: 2, content: 'Yes.' },
    });

    await tombstoneChatChunk(tx, [{ id: 'user' }, { id: 'assistant' }], 10, 11);

    expect(tx.order).toEqual(['read', 'write', 'write']);
    expect(tx.writes).toEqual([
      {
        id: 'user',
        data: { id: 'user', updatedAt: 10, deletedAt: 10, serverUpdatedAt: 11 },
        merge: false,
      },
      {
        id: 'assistant',
        data: { id: 'assistant', updatedAt: 10, deletedAt: 10, serverUpdatedAt: 11 },
        merge: false,
      },
    ]);
  });

  it('leaves a message whose stored updatedAt is newer than the clear', async () => {
    const tx = transaction({
      older: { updatedAt: 5 },
      newer: { updatedAt: 20 },
    });

    await tombstoneChatChunk(tx, [{ id: 'older' }, { id: 'newer' }], 10, 11);

    expect(tx.writes.map((write) => write.id)).toEqual(['older']);
  });
});

describe('isUuid', () => {
  it('accepts lowercase uuid', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
});

const PARENT_COLLECTION = '11111111-1111-4111-8111-111111111111';
const PARENT_RECIPE = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = '33333333-3333-4333-8333-333333333333';

function liveShare(ownerSub: string): Record<string, unknown> {
  return { ownerSub, collectionId: PARENT_COLLECTION, updatedAt: 1 };
}

function liveCollection(recipeIds: string[]): Record<string, unknown> {
  return {
    id: PARENT_COLLECTION,
    name: 'Shared',
    recipeIds,
    updatedAt: 1,
  };
}

function liveRecipe(): Record<string, unknown> {
  return {
    id: PARENT_RECIPE,
    title: 'Soup',
    ownerSub: 'recipe-document-owner',
    updatedAt: 1,
  };
}

describe('findSharedParentOwner', () => {
  type Share = { grantId: string; data: Record<string, unknown> };
  const collectionIdFor = (n: number) =>
    `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

  /** Share n belongs to owner-n and lists PARENT_RECIPE only when `listsParent`. */
  function world(
    shares: Array<{ owner: string; listsParent: boolean; revoked?: boolean }>,
  ) {
    const reads = { listAll: 0, listOwner: 0, collections: 0, recipes: 0 };
    const rows: Share[] = shares.map((share, n) => ({
      grantId: `${share.owner}_${collectionIdFor(n)}`,
      data: {
        ownerSub: share.owner,
        collectionId: collectionIdFor(n),
        updatedAt: 1,
        ...(share.revoked ? { deletedAt: 2 } : {}),
      },
    }));
    const io: SharedParentLookupIo = {
      listShares: async (ownerSub) => {
        if (ownerSub === null) {
          reads.listAll += 1;
          return rows;
        }
        reads.listOwner += 1;
        return rows.filter((row) => row.data.ownerSub === ownerSub);
      },
      readCollection: async (ownerSub, collectionId) => {
        reads.collections += 1;
        const n = shares.findIndex(
          (share, i) => share.owner === ownerSub && collectionIdFor(i) === collectionId,
        );
        return n === -1
          ? undefined
          : {
              id: collectionId,
              recipeIds: shares[n].listsParent ? [PARENT_RECIPE] : [],
              updatedAt: 1,
            };
      },
      readRecipe: async () => {
        reads.recipes += 1;
        return liveRecipe();
      },
    };
    return { io, reads };
  }

  it('reads only the share list when the viewer has no shares', async () => {
    const { io, reads } = world([]);
    await expect(findSharedParentOwner(PARENT_RECIPE, null, io)).resolves.toBeNull();
    expect(reads).toEqual({ listAll: 1, listOwner: 0, collections: 0, recipes: 0 });
  });

  it('stops at the first authorizing share', async () => {
    const { io, reads } = world([
      { owner: 'owner-a', listsParent: true },
      { owner: 'owner-b', listsParent: false },
      { owner: 'owner-c', listsParent: false },
    ]);
    await expect(findSharedParentOwner(PARENT_RECIPE, null, io)).resolves.toBe('owner-a');
    expect(reads).toEqual({ listAll: 1, listOwner: 0, collections: 1, recipes: 1 });
  });

  it('without a hint, a last-position match reads every collection', async () => {
    const shares = Array.from({ length: 12 }, (_, i) => ({
      owner: `owner-${i}`,
      listsParent: i === 11,
    }));
    const { io, reads } = world(shares);
    await expect(findSharedParentOwner(PARENT_RECIPE, null, io)).resolves.toBe('owner-11');
    expect(reads).toEqual({ listAll: 1, listOwner: 0, collections: 12, recipes: 1 });
  });

  it('with a stored hint, reads only the hinted owner\u2019s shares among many', async () => {
    const shares = Array.from({ length: 12 }, (_, i) => ({
      owner: `owner-${i}`,
      listsParent: i === 11,
    }));
    const { io, reads } = world(shares);
    await expect(findSharedParentOwner(PARENT_RECIPE, 'owner-11', io)).resolves.toBe(
      'owner-11',
    );
    expect(reads).toEqual({ listAll: 0, listOwner: 1, collections: 1, recipes: 1 });
  });

  it('falls back to a full scan when the hint no longer authorizes, without rechecking it', async () => {
    const { io, reads } = world([
      { owner: 'owner-old', listsParent: false },
      { owner: 'owner-new', listsParent: true },
    ]);
    await expect(findSharedParentOwner(PARENT_RECIPE, 'owner-old', io)).resolves.toBe(
      'owner-new',
    );
    expect(reads).toEqual({ listAll: 1, listOwner: 1, collections: 2, recipes: 1 });
  });

  it('denies after revoke even when the hint names that owner', async () => {
    const { io, reads } = world([{ owner: 'owner-a', listsParent: true, revoked: true }]);
    await expect(findSharedParentOwner(PARENT_RECIPE, 'owner-a', io)).resolves.toBeNull();
    expect(reads.collections).toBe(0);
    expect(reads.recipes).toBe(0);
  });

  it('cannot be steered to an owner the viewer has no share from', async () => {
    const { io } = world([{ owner: 'owner-a', listsParent: false }]);
    await expect(
      findSharedParentOwner(PARENT_RECIPE, 'someone-else', io),
    ).resolves.toBeNull();
  });
});

describe('storedSharedParentOwner', () => {
  it('reads only a non-empty server marker', () => {
    expect(storedSharedParentOwner({ [SHARED_PARENT_OWNER_SUB_FIELD]: 'owner' })).toBe(
      'owner',
    );
    expect(storedSharedParentOwner({ [SHARED_PARENT_OWNER_SUB_FIELD]: '' })).toBeNull();
    expect(storedSharedParentOwner({ [SHARED_PARENT_OWNER_SUB_FIELD]: 7 })).toBeNull();
    expect(storedSharedParentOwner(undefined)).toBeNull();
    expect(storedSharedParentOwner(null)).toBeNull();
  });
});

describe('shared parent provenance', () => {
  it('returns the owner stored on the incoming share', () => {
    expect(SHARED_PARENT_OWNER_SUB_FIELD).toBe('sharedParentOwnerSub');
    const allowed = {
      share: liveShare('stored-owner'),
      grantId: 'grant-1',
      collection: liveCollection([PARENT_RECIPE]),
      recipe: liveRecipe(),
    };
    const denied = {
      share: liveShare('other-owner'),
      grantId: 'grant-2',
      collection: liveCollection([]),
      recipe: { ...liveRecipe(), ownerSub: 'other-owner' },
    };
    expect(sharedParentOwnerFromCandidate(PARENT_RECIPE, denied)).toBeNull();
    expect(sharedParentOwnerFromCandidate(PARENT_RECIPE, allowed)).toBe('stored-owner');
    expect(
      sharedParentOwnerFromCandidate(PARENT_RECIPE, {
        ...allowed,
        share: { ...liveShare('stored-owner'), deletedAt: 5 },
      }),
    ).toBeNull();
    expect(
      sharedParentOwnerFromCandidate(PARENT_RECIPE, {
        ...allowed,
        share: liveShare(''),
      }),
    ).toBeNull();
    expect(
      sharedParentOwnerFromCandidate(PARENT_RECIPE, {
        ...allowed,
        recipe: { ...liveRecipe(), deletedAt: 5 },
      }),
    ).toBeNull();
  });

  it('stores the server-discovered owner and omits the marker for an owned parent', () => {
    expect(sharedParentMarkerForWrite(true, 'stored-owner')).toBeNull();
    expect(sharedParentMarkerForWrite(true, null)).toBeNull();
    expect(sharedParentMarkerForWrite(false, 'stored-owner')).toBe('stored-owner');
    expect(sharedParentMarkerForWrite(false, null)).toBeNull();
    expect(sharedParentMarkerForWrite(false, '')).toBeNull();
  });

  it('ignores a hostile chat or cook payload when choosing or clearing provenance', () => {
    const hostile = {
      id: CHAT_ID,
      recipeId: PARENT_RECIPE,
      role: 'user',
      content: 'hi',
      createdAt: 3,
      sharedParentOwnerSub: 'attacker',
      uid: 'uid',
      sub: 'sub',
      deletedAt: 1,
    };
    const cleared = chatOrCookPutBody(
      { ...hostile, sharedParentOwnerSub: null },
      CHAT_ID,
      3,
      9,
      sharedParentMarkerForWrite(false, 'stored-owner'),
    );
    expect(cleared.sharedParentOwnerSub).toBe('stored-owner');
    expect(cleared.uid).toBeUndefined();
    expect(cleared.sub).toBeUndefined();
    expect(cleared.deletedAt).toBeUndefined();
    expect(cleared.content).toBe('hi');

    const blank = chatOrCookPutBody(
      { ...hostile, sharedParentOwnerSub: '' },
      CHAT_ID,
      3,
      9,
      sharedParentMarkerForWrite(false, 'stored-owner'),
    );
    expect(blank.sharedParentOwnerSub).toBe('stored-owner');

    const owned = chatOrCookPutBody(
      hostile,
      CHAT_ID,
      3,
      9,
      sharedParentMarkerForWrite(true, 'stored-owner'),
    );
    expect(owned).not.toHaveProperty('sharedParentOwnerSub');
    expect(owned.serverUpdatedAt).toBe(9);
    expect(owned.updatedAt).toBe(3);

    const cook = chatOrCookPutBody(
      {
        recipeId: PARENT_RECIPE,
        servings: 2,
        currentStep: 0,
        checkedKeys: [],
        recipeUpdatedAt: 1,
        updatedAt: 4,
        sharedParentOwnerSub: 'attacker',
      },
      PARENT_RECIPE,
      4,
      10,
      null,
    );
    expect(cook).not.toHaveProperty('sharedParentOwnerSub');
    expect(cook.id).toBe(PARENT_RECIPE);
  });

  it('exposes the stored marker as chat and cook pull metadata only', () => {
    const wire = chatCookPullFields({
      id: CHAT_ID,
      recipeId: PARENT_RECIPE,
      role: 'user',
      content: 'hi',
      createdAt: 3,
      serverUpdatedAt: 9,
      deletedAt: null,
      sharedParentOwnerSub: 'stored-owner',
    });
    expect(wire.sharedParentOwnerSub).toBe('stored-owner');
    expect(wire).not.toHaveProperty('serverUpdatedAt');
    expect(wire).not.toHaveProperty('deletedAt');
    expect(wire.content).toBe('hi');

    expect(
      chatCookPullFields({
        id: CHAT_ID,
        content: 'owned',
        sharedParentOwnerSub: '',
        serverUpdatedAt: 1,
      }),
    ).not.toHaveProperty('sharedParentOwnerSub');
    expect(
      chatCookPullFields({
        id: CHAT_ID,
        content: 'owned',
        sharedParentOwnerSub: 4,
      }),
    ).not.toHaveProperty('sharedParentOwnerSub');
  });
});

describe('validateCookLogPut (shared table with isUsableCookLog)', () => {
  it.each(COOK_LOG_CASES)('$name → $valid', ({ entry, valid }) => {
    expect(validateCookLogPut(entry)).toBe(valid);
    expect(validatePushOp({ kind: 'cookLog.put', payload: entry }).ok).toBe(valid);
  });
});

describe('validateCookLogDelete', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('accepts an id and a finite updatedAt', () => {
    expect(validateCookLogDelete({ id, updatedAt: 3 })).toBe(true);
    expect(validatePushOp({ kind: 'cookLog.delete', payload: { id, updatedAt: 3 } }).ok).toBe(true);
  });

  it('rejects a bad id, a missing updatedAt, or a non-object', () => {
    expect(validateCookLogDelete({ id: 'x', updatedAt: 3 })).toBe(false);
    expect(validateCookLogDelete({ id })).toBe(false);
    expect(validateCookLogDelete({ id, updatedAt: '3' })).toBe(false);
    expect(validateCookLogDelete(null)).toBe(false);
  });
});

describe('cook log push kinds', () => {
  it('are known', () => {
    expect(isKnownPushKind('cookLog.put')).toBe(true);
    expect(isKnownPushKind('cookLog.delete')).toBe(true);
    expect(isKnownPushKind('cookLog.move')).toBe(false);
  });
});

describe('isCookedOn (server copy)', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isCookedOn('2024-02-29')).toBe(true);
    expect(isCookedOn('2026-02-30')).toBe(false);
    expect(isCookedOn('1900-02-29')).toBe(false);
    expect(isCookedOn('2026-9-26')).toBe(false);
  });
});

describe('compactCookLogFields', () => {
  it('drops unknown keys and trims text, matching the client compactor', () => {
    expect(compactCookLogFields(FULL_COOK_LOG_UNCOMPACTED)).toEqual(FULL_COOK_LOG);
  });

  it('omits blank text and empty photoIds', () => {
    expect(compactCookLogFields(MINIMAL_COOK_LOG_UNCOMPACTED)).toEqual(MINIMAL_COOK_LOG);
  });

  it('strips server bookkeeping from a stored doc', () => {
    expect(
      compactCookLogFields({ ...FULL_COOK_LOG, serverUpdatedAt: 9, uid: 'u', sub: 's' }),
    ).toEqual(FULL_COOK_LOG);
  });
});

describe('cookLogMovesRecipe', () => {
  const recipeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('rejects a put that changes the recipe of a live entry', () => {
    expect(cookLogMovesRecipe({ recipeId, updatedAt: 1 }, { recipeId: otherId })).toBe(true);
  });

  it('allows the same recipe, a new entry, and a tombstone', () => {
    expect(cookLogMovesRecipe({ recipeId, updatedAt: 1 }, { recipeId })).toBe(false);
    expect(cookLogMovesRecipe(null, { recipeId: otherId })).toBe(false);
    expect(
      cookLogMovesRecipe({ id: 'x', updatedAt: 1, deletedAt: 1 }, { recipeId: otherId }),
    ).toBe(false);
  });
});

describe('forcedTombstoneAt', () => {
  it('uses the delete time for an older or missing child', () => {
    expect(forcedTombstoneAt(10, { updatedAt: 5 })).toBe(10);
    expect(forcedTombstoneAt(10, null)).toBe(10);
  });

  it('raises to the stored time for a child edited after the delete', () => {
    expect(forcedTombstoneAt(10, { updatedAt: 20 })).toBe(20);
  });

  it('skips a child that is already a tombstone', () => {
    expect(forcedTombstoneAt(10, { updatedAt: 5, deletedAt: 5 })).toBeNull();
    expect(forcedTombstoneAt(10, { updatedAt: 20, deletedAt: 20 })).toBeNull();
  });
});

describe('cascadeChildJobs', () => {
  const jobs = cascadeChildJobs({
    chatIds: ['m1'],
    cookStateIds: ['r1'],
    cookLogIds: ['l1'],
    photoIds: ['p1'],
  });

  it('forces cook logs and photos but not chat or cookState', () => {
    expect(jobs).toEqual([
      { kind: 'chatMessages', id: 'm1', forced: false },
      { kind: 'cookState', id: 'r1', forced: false },
      { kind: 'cookLogs', id: 'l1', forced: true },
      { kind: 'photos', id: 'p1', forced: true },
    ]);
  });

  it('tombstones a newer cook log or photo but skips a newer chat or cookState', () => {
    const newer = { updatedAt: 20 };
    expect(jobs.map((job) => cascadeTombstoneAt(job, 10, newer))).toEqual([null, null, 20, 20]);
  });

  it('tombstones every older child at the delete time', () => {
    const older = { updatedAt: 5 };
    expect(jobs.map((job) => cascadeTombstoneAt(job, 10, older))).toEqual([10, 10, 10, 10]);
  });

  it('counts cook logs like chat messages in the batch cost', () => {
    expect(
      chunkByCost(jobs, cascadeJobCost, 3).map((chunk) =>
        chunk.map((job) => job.id),
      ),
    ).toEqual([['m1', 'r1', 'l1'], ['p1']]);
  });
});

describe('translationCacheDocIds', () => {
  it('names the four UI-language cache docs, in order, with no query', () => {
    const recipeId = '550e8400-e29b-41d4-a716-446655440000';
    expect(translationCacheDocIds(recipeId)).toEqual([
      `${recipeId}.en`,
      `${recipeId}.uk`,
      `${recipeId}.ru`,
      `${recipeId}.zh-Hans`,
    ]);
    expect(translationCacheDocIds(recipeId)).toEqual(translationCacheDocIds(recipeId));
    for (const id of translationCacheDocIds(recipeId)) {
      expect(id.includes('/')).toBe(false);
    }
  });
});

describe('foldListLiveDocsCandidate', () => {
  const limits = { maxDocs: 2, maxBytes: 100 };

  function live(doc: Record<string, unknown>, jsonBytes: number) {
    return { live: true as const, doc, jsonBytes };
  }

  it('skips non-live candidates', () => {
    let acc = createListLiveDocsAccumulator();
    acc = foldListLiveDocsCandidate(
      acc,
      { live: false, doc: { id: 't' }, jsonBytes: 0 },
      limits,
    );
    expect(acc).toEqual(createListLiveDocsAccumulator());
  });

  it('keeps live docs until maxDocs and sets truncated on the next live doc', () => {
    let acc = createListLiveDocsAccumulator();
    acc = foldListLiveDocsCandidate(acc, live({ id: 'a' }, 10), limits);
    acc = foldListLiveDocsCandidate(acc, live({ id: 'b' }, 10), limits);
    expect(acc.docs).toHaveLength(2);
    expect(acc.truncated).toBe(false);
    expect(acc.done).toBe(false);
    acc = foldListLiveDocsCandidate(acc, live({ id: 'c' }, 10), limits);
    expect(acc.docs).toHaveLength(2);
    expect(acc.truncated).toBe(true);
    expect(acc.done).toBe(true);
  });

  it('sets truncated when the next doc would exceed maxBytes', () => {
    let acc = createListLiveDocsAccumulator();
    acc = foldListLiveDocsCandidate(acc, live({ id: 'a' }, 60), limits);
    acc = foldListLiveDocsCandidate(acc, live({ id: 'b' }, 50), limits);
    expect(acc.docs).toHaveLength(1);
    expect(acc.truncated).toBe(true);
    expect(acc.done).toBe(true);
  });

  it('omits an oversized first doc and sets truncated without throwing', () => {
    let acc = createListLiveDocsAccumulator();
    acc = foldListLiveDocsCandidate(acc, live({ id: 'big' }, 200), limits);
    expect(acc.docs).toHaveLength(0);
    expect(acc.truncated).toBe(true);
    expect(acc.done).toBe(true);
  });

  it('does not mutate after done', () => {
    let acc = createListLiveDocsAccumulator();
    acc = foldListLiveDocsCandidate(acc, live({ id: 'a' }, 10), limits);
    acc = foldListLiveDocsCandidate(acc, live({ id: 'b' }, 10), limits);
    acc = foldListLiveDocsCandidate(acc, live({ id: 'c' }, 10), limits);
    acc = foldListLiveDocsCandidate(acc, live({ id: 'd' }, 10), limits);
    expect(acc.docs.map((d) => d.id)).toEqual(['a', 'b']);
  });
});
