import { describe, expect, it } from 'vitest';
import { decideSyncToast } from './syncEngine';
import { applyPullChanges, mergePullCursor } from './remote';

describe('mergePullCursor', () => {
  it('overlays the next page onto the previous cursor', () => {
    const prev = { recipes: [1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] as [number, string] };
    const next = { chatMessages: [2, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] as [number, string] };
    expect(mergePullCursor(prev, next)).toEqual({
      recipes: prev.recipes,
      chatMessages: next.chatMessages,
    });
  });
});

describe('applyPullChanges', () => {
  it('upserts live docs and drops tombstones', () => {
    const acc = {
      recipes: new Map(),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set<string>(),
    };
    applyPullChanges(acc, {
      recipes: [
        {
          id: 'r1',
          createdAt: 1,
          updatedAt: 2,
          title: 'Soup',
          servings: 2,
          ingredientSections: [{ items: [{ item: 'water' }] }],
          steps: [{ text: 'Boil.' }],
          tags: [],
        },
      ],
      chatMessages: [
        {
          id: 'c1',
          recipeId: 'r1',
          role: 'user',
          content: 'hi',
          createdAt: 3,
        },
      ],
      cookState: [
        {
          recipeId: 'r1',
          servings: 4,
          currentStep: 1,
          checkedKeys: ['0-0'],
          recipeUpdatedAt: 2,
        },
      ],
      photos: [{ id: 'p1' }],
    });
    expect(acc.recipes.get('r1')?.title).toBe('Soup');
    expect(acc.chat.get('c1')?.content).toBe('hi');
    expect(acc.cook.get('r1')?.servings).toBe(4);
    expect(acc.remotePhotoIds.has('p1')).toBe(true);

    applyPullChanges(acc, {
      recipes: [{ id: 'r1', deletedAt: 9 }],
      chatMessages: [{ id: 'c1', deletedAt: 9 }],
      cookState: [{ recipeId: 'r1', deletedAt: 9 }],
      photos: [{ id: 'p1', deletedAt: 9 }],
    });
    expect(acc.recipes.size).toBe(0);
    expect(acc.chat.size).toBe(0);
    expect(acc.cook.size).toBe(0);
    expect(acc.remotePhotoIds.size).toBe(0);
  });

  it('upserts live collections and drops tombstones', () => {
    const acc = {
      recipes: new Map(),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set<string>(),
    };
    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [],
      cookState: [],
      photos: [],
      collections: [
        {
          id: 'c1',
          name: 'Dinners',
          recipeIds: ['r1'],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    expect(acc.collections.get('c1')?.name).toBe('Dinners');
    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [],
      cookState: [],
      photos: [],
      collections: [{ id: 'c1', deletedAt: 9 }],
    });
    expect(acc.collections.size).toBe(0);
  });

  const COOK_LOG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const COOK_RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function emptyAcc() {
    return {
      recipes: new Map(),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set<string>(),
    };
  }

  it('upserts live cook logs compacted and drops tombstones', () => {
    const acc = emptyAcc();
    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [],
      cookState: [],
      photos: [],
      cookLogs: [
        {
          id: COOK_LOG_ID,
          recipeId: COOK_RECIPE_ID,
          cookedOn: '2026-09-20',
          rating: 4,
          notes: '  Less salt.  ',
          stray: 'dropped',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    expect(acc.cookLogs.get(COOK_LOG_ID)).toEqual({
      id: COOK_LOG_ID,
      recipeId: COOK_RECIPE_ID,
      cookedOn: '2026-09-20',
      createdAt: 1,
      updatedAt: 2,
      rating: 4,
      notes: 'Less salt.',
    });

    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [],
      cookState: [],
      photos: [],
      cookLogs: [{ id: COOK_LOG_ID, deletedAt: 9 }],
    });
    expect(acc.cookLogs.size).toBe(0);
  });

  it('drops an unusable live cook log from the map', () => {
    const acc = emptyAcc();
    acc.cookLogs.set(COOK_LOG_ID, {
      id: COOK_LOG_ID,
      recipeId: COOK_RECIPE_ID,
      cookedOn: '2026-09-20',
      createdAt: 1,
      updatedAt: 2,
    });
    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [],
      cookState: [],
      photos: [],
      cookLogs: [
        {
          id: COOK_LOG_ID,
          recipeId: COOK_RECIPE_ID,
          cookedOn: '2026-02-30',
          createdAt: 1,
          updatedAt: 3,
        },
      ],
    });
    expect(acc.cookLogs.size).toBe(0);
  });

  it('leaves cook logs alone when an old server omits the key', () => {
    const acc = emptyAcc();
    const log = {
      id: COOK_LOG_ID,
      recipeId: COOK_RECIPE_ID,
      cookedOn: '2026-09-20',
      createdAt: 1,
      updatedAt: 2,
    };
    acc.cookLogs.set(COOK_LOG_ID, log);
    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [],
      cookState: [],
      photos: [],
    });
    expect(acc.cookLogs.get(COOK_LOG_ID)).toEqual(log);
  });
});

describe('decideSyncToast', () => {
  it('toasts a material refresh', () => {
    expect(decideSyncToast({ outcome: 'ok', pushed: 0, applied: 3 })).toEqual({
      kind: 'success',
      message: 'Updated',
    });
  });

  it('stays silent on a no-op pull', () => {
    expect(decideSyncToast({ outcome: 'ok', pushed: 0, applied: 0 })).toBeNull();
  });

  it('toasts refresh errors', () => {
    expect(decideSyncToast({ outcome: 'error', pushed: 0, applied: 0 })).toEqual({
      kind: 'error',
      message: "Couldn't refresh",
    });
  });

  it('stays silent for signed-out, offline, and skipped', () => {
    expect(decideSyncToast({ outcome: 'offline', pushed: 0, applied: 0 })).toBeNull();
    expect(decideSyncToast({ outcome: 'signedOut', pushed: 1, applied: 0 })).toBeNull();
    expect(decideSyncToast({ outcome: 'skipped', pushed: 0, applied: 0 })).toBeNull();
  });
});
