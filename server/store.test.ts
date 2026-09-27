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
  chunkByCost,
  chunkForBatch,
  applyCollectionMembershipScrubs,
  collectionDocsFromQuerySnap,
  collectionsToScrub,
  compactCollectionFields,
  compactCookLogFields,
  compactRecipeFields,
  compareMutation,
  cookLogMovesRecipe,
  forcedTombstoneAt,
  isCookedOn,
  isKnownPushKind,
  MAX_NAMED_COLLECTIONS,
  namedCollectionCreateCapReason,
  decodePullCursor,
  encodePullCursor,
  isUuid,
  messageIdsToClearAtBoundary,
  validateCookLogDelete,
  validateCookLogPut,
  validatePushOp,
} from './store.ts';

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

describe('namedCollectionCreateCapReason', () => {
  it('returns cap only when the live count is already at the limit', () => {
    expect(namedCollectionCreateCapReason(MAX_NAMED_COLLECTIONS - 1)).toBeUndefined();
    expect(namedCollectionCreateCapReason(MAX_NAMED_COLLECTIONS)).toBe('cap');
    expect(namedCollectionCreateCapReason(MAX_NAMED_COLLECTIONS + 1)).toBe('cap');
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

describe('isUuid', () => {
  it('accepts lowercase uuid', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
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
