import { describe, expect, it } from 'vitest';
import {
  addedCollectionRecipeIds,
  chunkByCost,
  chunkForBatch,
  applyCollectionMembershipScrubs,
  collectionDocsFromQuerySnap,
  collectionsToScrub,
  compactCollectionFields,
  compactRecipeFields,
  compareMutation,
  recipeIdsWithoutTombstones,
  decodePullCursor,
  encodePullCursor,
  isUuid,
  messageIdsToClearAtBoundary,
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

describe('isUuid', () => {
  it('accepts lowercase uuid', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
});
