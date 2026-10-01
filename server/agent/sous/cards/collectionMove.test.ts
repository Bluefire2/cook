import { describe, expect, it } from 'vitest';
import { MAX_COLLECTION_RECIPE_IDS } from '../../../store.ts';
import { replayCards } from '../../request.ts';
import { buildAgentLibrary, type AgentCollection, type AgentRecipe } from '../library.ts';
import {
  collectionMoveHistoryText,
  normalizeCollectionMove,
  revalidateCollectionMove,
  type CollectionMoveData,
} from './collectionMove.ts';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function lib(
  recipes: AgentRecipe[],
  collections: AgentCollection[],
  opts: { truncated?: boolean; maxIndexEntries?: number } = {},
) {
  return buildAgentLibrary(recipes, collections, {
    truncated: opts.truncated ?? false,
    maxIndexEntries: opts.maxIndexEntries ?? 500,
    maxIndexChars: 40_000,
  });
}

describe('normalizeCollectionMove', () => {
  const recipes = [
    recipe({ id: 'r1', title: 'One' }),
    recipe({ id: 'r2', title: 'Two' }),
    recipe({ id: 'r3', title: 'Three' }),
  ];
  const collections: AgentCollection[] = [
    { id: 'col-a', name: 'Alpha', recipeIds: ['r1'] },
    { id: 'col-b', name: 'Beta', recipeIds: ['r2', 'r1'] },
  ];

  it('moves all recipes into a collection by id', () => {
    const ctx = lib(recipes, collections);
    const result = normalizeCollectionMove(
      { all: true, collectionId: 'col-a' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.total).toBe(2);
    expect(result.data.recipeIds).toEqual(expect.arrayContaining(['r2', 'r3']));
    expect(result.data.recipeIds).not.toContain('r1');
    expect(result.data.destination).toEqual({ kind: 'collection', id: 'col-a', name: 'Alpha' });
  });

  it('selects by fromCollectionId using winning membership', () => {
    const ctx = lib(recipes, collections);
    const result = normalizeCollectionMove(
      { fromCollectionId: 'col-b', collectionId: 'col-a' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.recipeIds).toEqual(['r2']);
  });

  it('moves explicit recipe ids', () => {
    const ctx = lib(recipes, [{ id: 'c1', name: 'New Home', recipeIds: [] }]);
    const result = normalizeCollectionMove({ recipeIds: ['r1', 'r2'], name: 'New Home' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.recipeIds).toEqual(['r1', 'r2']);
  });

  it('rejects ambiguous collection name', () => {
    const ctx = lib(recipes, [
      { id: 'c1', name: 'Dinner', recipeIds: [] },
      { id: 'c2', name: 'dinner', recipeIds: [] },
    ]);
    const result = normalizeCollectionMove({ recipeIds: ['r1'], name: 'Dinner' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('ambiguous');
  });

  it('lists owned names when name does not match', () => {
    const ctx = lib(recipes, [{ id: 'c1', name: 'Weeknight', recipeIds: [] }]);
    const result = normalizeCollectionMove({ recipeIds: ['r1'], name: 'Missing' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('Weeknight');
    expect(result.error).toContain('Shared collections cannot be destinations');
  });

  it('treats unfiled alias when no owned collection has that name', () => {
    const ctx = lib(
      [recipe({ id: 'r1', title: 'One' })],
      [{ id: 'col', name: 'Alpha', recipeIds: ['r1'] }],
    );
    const result = normalizeCollectionMove({ recipeIds: ['r1'], name: 'Unfiled' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.destination).toEqual({ kind: 'unfiled' });
    expect(result.data.recipeIds).toEqual(['r1']);
  });

  it('prefers an owned collection named Recipes over the unfiled alias', () => {
    const ctx = lib(
      [recipe({ id: 'r1', title: 'One' })],
      [
        { id: 'recipes-col', name: 'Recipes', recipeIds: [] },
        { id: 'other', name: 'Other', recipeIds: ['r1'] },
      ],
    );
    const result = normalizeCollectionMove({ recipeIds: ['r1'], name: 'recipes' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.destination).toEqual({
      kind: 'collection',
      id: 'recipes-col',
      name: 'Recipes',
    });
  });

  it('refuses union over 500 recipes', () => {
    const existing = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `e${i}`);
    const ctx = lib(
      [recipe({ id: 'r-new', title: 'New' }), ...existing.map((id) => recipe({ id, title: id }))],
      [{ id: 'dest', name: 'Dest', recipeIds: existing }],
    );
    const result = normalizeCollectionMove({ recipeIds: ['r-new'], collectionId: 'dest' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('500');
  });

  it('refuses more than 500 ids for unfiled destination', () => {
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS + 1 }, (_, i) => `r${i}`);
    const ctx = lib(
      ids.map((id) => recipe({ id, title: id })),
      [{ id: 'col', name: 'Big', recipeIds: ids }],
    );
    const result = normalizeCollectionMove({ fromCollectionId: 'col', unfiled: true }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('500');
  });

  it('refuses all when load was truncated', () => {
    const ctx = lib(recipes, collections, { truncated: true });
    expect(ctx.loadTruncated).toBe(true);
    const result = normalizeCollectionMove({ all: true, collectionId: 'col-a' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('truncated');
  });

  it('allows all when only the index was truncated', () => {
    const ctx = lib(recipes, collections, { truncated: false, maxIndexEntries: 1 });
    expect(ctx.loadTruncated).toBe(false);
    expect(ctx.truncated).toBe(true);
    const result = normalizeCollectionMove({ all: true, collectionId: 'col-a' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('fails when every recipe is already in the destination', () => {
    const ctx = lib([recipe({ id: 'r1', title: 'One' })], [
      { id: 'col', name: 'Main', recipeIds: ['r1'] },
    ]);
    const result = normalizeCollectionMove({ recipeIds: ['r1'], collectionId: 'col' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('already in the destination');
  });

  it('selects unfiled recipes with fromCollectionId unfiled', () => {
    const ctx = lib(recipes, collections);
    const result = normalizeCollectionMove({ fromCollectionId: 'unfiled', collectionId: 'col-a' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.recipeIds).toEqual(['r3']);
  });
});

describe('revalidateCollectionMove', () => {
  const baseData: CollectionMoveData = {
    destination: { kind: 'collection', id: 'col-a', name: 'Old Name' },
    recipeIds: ['r1'],
    preview: [{ id: 'r1', title: 'One', from: { kind: 'unfiled' } }],
    total: 1,
  };

  it('still ok after move applied and refreshes destination name', () => {
    const ctx = lib(
      [recipe({ id: 'r1', title: 'One' })],
      [{ id: 'col-a', name: 'Renamed', recipeIds: ['r1'] }],
    );
    const result = revalidateCollectionMove(baseData, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.destination.kind).toBe('collection');
    if (result.data.destination.kind !== 'collection') {
      return;
    }
    expect(result.data.destination.name).toBe('Renamed');
    expect(collectionMoveHistoryText(result.data)).toContain('Renamed');
    expect(collectionMoveHistoryText(result.data)).not.toContain('Old Name');
  });

  it('fails when destination collection was deleted', () => {
    const ctx = lib([recipe({ id: 'r1', title: 'One' })], []);
    const result = revalidateCollectionMove(baseData, ctx);
    expect(result.ok).toBe(false);
  });

  it('fails when more than 500 recipe ids', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `r${i}`);
    const ctx = lib([], []);
    const result = revalidateCollectionMove(
      {
        destination: { kind: 'unfiled' },
        recipeIds: ids,
        preview: [],
        total: 501,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('fails when a preview title exceeds 120 characters', () => {
    const ctx = lib([recipe({ id: 'r1', title: 'One' })], []);
    const result = revalidateCollectionMove(
      {
        destination: { kind: 'unfiled' },
        recipeIds: ['r1'],
        preview: [{ id: 'r1', title: 'x'.repeat(121), from: { kind: 'unfiled' } }],
        total: 1,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});

describe('replayCards collection_move', () => {
  it('uses revalidate for collection_move cards', () => {
    const ctx = lib(
      [recipe({ id: 'r1', title: 'One' })],
      [{ id: 'col-a', name: 'Current', recipeIds: ['r1'] }],
    );
    const cardData: CollectionMoveData = {
      destination: { kind: 'collection', id: 'col-a', name: 'Stale' },
      recipeIds: ['r1'],
      preview: [{ id: 'r1', title: 'One', from: { kind: 'collection', name: 'X' } }],
      total: 1,
    };
    const out = replayCards(
      [
        {
          role: 'assistant',
          content: 'Move',
          cards: [{ type: 'collection_move', v: 1, data: cardData }],
        },
        { role: 'user', content: 'ok' },
      ],
      ctx,
    );
    expect(out[0]?.text).toContain('Current');
    expect(out[0]?.text).not.toContain('Stale');
  });
});
