import { afterEach, describe, expect, it } from 'vitest';
import { decideSyncToast, MAX_SHARED_PULL_ATTEMPTS, pullAll } from './syncEngine';
import {
  addPendingBlob,
  clearLibrary,
  getSnapshot,
  mergeSharedFromPull,
  replaceFromPull,
  setGrantCount,
  subscribe,
} from './libraryMemory';
import {
  applyPullChanges,
  mergePullCursor,
  type PullChanges,
  type PullPage,
  type SharedPullPage,
} from './remote';
import type { ChatMessage, Collection, Recipe } from './types';
import type { CookStateRow } from './useCookState';

function recipe(id: string, title: string): Recipe {
  return {
    id,
    title,
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function collection(id: string, name: string, recipeIds: string[] = []): Collection {
  return {
    id,
    name,
    recipeIds,
    createdAt: 1,
    updatedAt: 2,
  };
}

function chat(id: string, recipeId: string, content: string): ChatMessage {
  return {
    id,
    recipeId,
    role: 'user',
    content,
    createdAt: 3,
  };
}

function cook(recipeId: string, servings: number): CookStateRow {
  return {
    recipeId,
    servings,
    currentStep: 1,
    checkedKeys: ['0-0'],
    recipeUpdatedAt: 2,
  };
}

function pullDoc<T extends object>(value: T): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

function ownedChanges(overrides: Partial<PullChanges> = {}): PullChanges {
  return {
    recipes: [],
    collections: [],
    chatMessages: [],
    cookState: [],
    photos: [],
    ...overrides,
  };
}

function ownedPage(
  changes: PullChanges,
  options: { hasMore?: boolean; cursor?: PullPage['cursor'] } = {},
): PullPage {
  return {
    changes,
    cursor: options.cursor ?? {},
    hasMore: options.hasMore ?? false,
  };
}

function sharedPage(
  changes: Partial<SharedPullPage['changes']> = {},
  options: { hasMore?: boolean; cursorToken?: string } = {},
): SharedPullPage {
  return {
    changes: {
      recipes: [],
      collections: [],
      photos: [],
      ...changes,
    },
    cursorToken: options.cursorToken ?? '',
    hasMore: options.hasMore ?? false,
  };
}

afterEach(() => {
  clearLibrary();
});

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
});

describe('pullAll', () => {
  it('installs completed owned state and clears old shared state when shared pull fails', async () => {
    const oldOwn = recipe('old-own', 'Old owned');
    const oldShared = recipe('old-shared', 'Old shared');
    replaceFromPull({
      recipes: new Map([[oldOwn.id, oldOwn]]),
      collections: new Map([['old-owned-collection', collection('old-owned-collection', 'Old')]]),
      chat: new Map([['old-message', chat('old-message', oldOwn.id, 'old')]]),
      cook: new Map([[oldOwn.id, cook(oldOwn.id, 1)]]),
      remotePhotoIds: new Set(['old-owned-photo']),
    });
    mergeSharedFromPull({
      recipes: new Map([[oldShared.id, oldShared]]),
      collections: new Map([
        ['old-shared-collection', collection('old-shared-collection', 'Old shared')],
      ]),
      remotePhotoIds: new Set(['old-shared-photo']),
      recipeOrigins: new Map([
        [oldShared.id, { kind: 'shared', ownerSub: 'old-owner' }],
      ]),
      collectionOrigins: new Map([
        ['old-shared-collection', { kind: 'shared', ownerSub: 'old-owner' }],
      ]),
    });
    addPendingBlob('pending-photo', new Blob(['pending']));
    setGrantCount('known-grants', 2);
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });

    const result = await pullAll({
      pullPage: async () =>
        ownedPage(
          ownedChanges({
            recipes: [pullDoc(recipe('new-own', 'New owned'))],
            collections: [
              pullDoc(collection('new-owned-collection', 'New', ['new-own'])),
            ],
            chatMessages: [pullDoc(chat('new-message', 'new-own', 'new'))],
            cookState: [pullDoc(cook('new-own', 4))],
            photos: [{ id: 'new-owned-photo' }],
          }),
        ),
      pullSharedPage: async () => 'error',
    });
    unsubscribe();

    const snapshot = getSnapshot();
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe(snapshot);
    expect(result).toEqual({ outcome: 'error', pushed: 0, applied: 0 });
    expect(snapshot.loaded).toBe(true);
    expect([...snapshot.recipes.keys()]).toEqual(['new-own']);
    expect([...snapshot.collections.keys()]).toEqual(['new-owned-collection']);
    expect([...snapshot.chat.keys()]).toEqual(['new-message']);
    expect([...snapshot.cook.keys()]).toEqual(['new-own']);
    expect([...snapshot.remotePhotoIds]).toEqual(['new-owned-photo']);
    expect(snapshot.recipeOrigins.get('new-own')).toEqual({ kind: 'own' });
    expect(snapshot.collectionOrigins.get('new-owned-collection')).toEqual({ kind: 'own' });
    expect(snapshot.recipeOrigins.has('old-shared')).toBe(false);
    expect(snapshot.collectionOrigins.has('old-shared-collection')).toBe(false);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
    expect(snapshot.grantCounts.get('known-grants')).toBe(2);
  });

  it('does not merge a successful first shared page when a later page fails', async () => {
    replaceFromPull({
      recipes: new Map([['prior-owned', recipe('prior-owned', 'Prior owned')]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(['prior-owned-photo']),
    });
    mergeSharedFromPull({
      recipes: new Map([['prior-shared', recipe('prior-shared', 'Prior shared')]]),
      collections: new Map([
        ['prior-shared-collection', collection('prior-shared-collection', 'Prior shared')],
      ]),
      remotePhotoIds: new Set(['prior-shared-photo']),
      recipeOrigins: new Map([
        ['prior-shared', { kind: 'shared', ownerSub: 'prior-owner' }],
      ]),
      collectionOrigins: new Map([
        ['prior-shared-collection', { kind: 'shared', ownerSub: 'prior-owner' }],
      ]),
    });
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });
    let sharedCalls = 0;
    const result = await pullAll({
      pullPage: async () =>
        ownedPage(ownedChanges({ recipes: [pullDoc(recipe('owned', 'Owned'))] })),
      pullSharedPage: async (cursor) => {
        sharedCalls += 1;
        if (sharedCalls === 1) {
          expect(cursor).toBeNull();
          return sharedPage(
            {
              recipes: [{ ...recipe('partial-shared', 'Partial'), ownerSub: 'owner' }],
              photos: [{ id: 'partial-photo' }],
            },
            { hasMore: true, cursorToken: 'next-shared' },
          );
        }
        expect(cursor).toBe('next-shared');
        return 'error';
      },
    });
    unsubscribe();

    const snapshot = getSnapshot();
    expect(result.outcome).toBe('error');
    expect(sharedCalls).toBe(2);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe(snapshot);
    expect([...snapshot.recipes.keys()]).toEqual(['owned']);
    expect(snapshot.remotePhotoIds.has('partial-photo')).toBe(false);
    expect(snapshot.recipeOrigins.has('partial-shared')).toBe(false);
    expect(snapshot.recipeOrigins.has('prior-shared')).toBe(false);
    expect(snapshot.collectionOrigins.has('prior-shared-collection')).toBe(false);
    expect(snapshot.remotePhotoIds.has('prior-shared-photo')).toBe(false);
  });

  it('keeps installed owned state and returns error when shared pulling throws', async () => {
    const result = await pullAll({
      pullPage: async () =>
        ownedPage(ownedChanges({ recipes: [pullDoc(recipe('owned', 'Owned'))] })),
      pullSharedPage: async () => {
        throw new Error('network failed');
      },
    });

    expect(result.outcome).toBe('error');
    expect([...getSnapshot().recipes.keys()]).toEqual(['owned']);
  });

  it('clears the whole library when shared pull signs out after owned install', async () => {
    replaceFromPull({
      recipes: new Map([['old', recipe('old', 'Old')]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(['old-photo']),
    });
    addPendingBlob('pending', new Blob(['pending']));
    setGrantCount('collection', 1);
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });

    const result = await pullAll({
      pullPage: async () =>
        ownedPage(ownedChanges({ recipes: [pullDoc(recipe('new', 'New'))] })),
      pullSharedPage: async () => 'signedOut',
    });
    unsubscribe();

    const snapshot = getSnapshot();
    expect(result.outcome).toBe('signedOut');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe(snapshot);
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.recipes.size).toBe(0);
    expect(snapshot.collections.size).toBe(0);
    expect(snapshot.chat.size).toBe(0);
    expect(snapshot.cook.size).toBe(0);
    expect(snapshot.remotePhotoIds.size).toBe(0);
    expect(snapshot.pendingBlobs.size).toBe(0);
    expect(snapshot.recipeOrigins.size).toBe(0);
    expect(snapshot.collectionOrigins.size).toBe(0);
    expect(snapshot.grantCounts.size).toBe(0);
  });

  it('does not install incomplete owned state when a later owned page fails', async () => {
    replaceFromPull({
      recipes: new Map([['existing', recipe('existing', 'Existing')]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });
    let ownedCalls = 0;
    let sharedCalled = false;
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });

    const result = await pullAll({
      pullPage: async (cursor) => {
        ownedCalls += 1;
        if (ownedCalls === 1) {
          expect(cursor).toBeNull();
          return ownedPage(
            ownedChanges({
              recipes: [pullDoc(recipe('partial-owned', 'Partial'))],
            }),
            {
              hasMore: true,
              cursor: { recipes: [2, 'partial-owned'] },
            },
          );
        }
        expect(cursor).toEqual({ recipes: [2, 'partial-owned'] });
        return 'error';
      },
      pullSharedPage: async () => {
        sharedCalled = true;
        return sharedPage();
      },
    });
    unsubscribe();

    expect(result.outcome).toBe('error');
    expect(ownedCalls).toBe(2);
    expect(sharedCalled).toBe(false);
    expect(emissions).toHaveLength(0);
    expect([...getSnapshot().recipes.keys()]).toEqual(['existing']);
  });

  it('clears existing state when owned pull signs out', async () => {
    replaceFromPull({
      recipes: new Map([['existing', recipe('existing', 'Existing')]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });

    const result = await pullAll({
      pullPage: async () => 'signedOut',
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('signedOut');
    expect(getSnapshot().recipes.size).toBe(0);
  });

  it('publishes completed owned and multi-page shared state exactly once', async () => {
    addPendingBlob('pending-photo', new Blob(['pending']));
    setGrantCount('collection-collision', 3);
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });
    let sharedCalls = 0;
    const result = await pullAll({
      pullPage: async () =>
        ownedPage(
          ownedChanges({
            recipes: [pullDoc(recipe('collision', 'Owned collision'))],
            collections: [
              pullDoc(collection('collection-collision', 'Owned collection')),
            ],
            photos: [{ id: 'owned-photo' }],
          }),
        ),
      pullSharedPage: async (cursor) => {
        sharedCalls += 1;
        if (sharedCalls === 1) {
          expect(cursor).toBeNull();
          return sharedPage(
            {
              recipes: [
                { ...recipe('collision', 'Shared collision'), ownerSub: 'shared-owner' },
                { ...recipe('shared-one', 'Shared one'), ownerSub: 'shared-owner' },
              ],
              collections: [
                {
                  ...collection('collection-collision', 'Shared collision'),
                  ownerSub: 'shared-owner',
                },
                {
                  ...collection('shared-collection', 'Shared collection', [
                    'shared-one',
                    'shared-two',
                  ]),
                  ownerSub: 'shared-owner',
                },
              ],
              photos: [{ id: 'shared-photo-one' }],
            },
            { hasMore: true, cursorToken: 'shared-page-two' },
          );
        }
        expect(cursor).toBe('shared-page-two');
        return sharedPage({
          recipes: [
            { ...recipe('shared-two', 'Shared two'), ownerSub: 'shared-owner' },
          ],
          photos: [{ id: 'shared-photo-two' }],
        });
      },
    });
    unsubscribe();

    const snapshot = getSnapshot();
    expect(result.outcome).toBe('ok');
    expect(sharedCalls).toBe(2);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe(snapshot);
    expect(emissions[0]?.collections.get('shared-collection')?.recipeIds).toEqual([
      'shared-one',
      'shared-two',
    ]);
    expect(emissions[0]?.recipes.has('shared-one')).toBe(true);
    expect(emissions[0]?.recipes.has('shared-two')).toBe(true);
    expect(snapshot.recipes.get('collision')?.title).toBe('Owned collision');
    expect(snapshot.recipeOrigins.get('collision')).toEqual({ kind: 'own' });
    expect(snapshot.recipes.get('shared-one')?.title).toBe('Shared one');
    expect(snapshot.recipeOrigins.get('shared-one')).toEqual({
      kind: 'shared',
      ownerSub: 'shared-owner',
    });
    expect(snapshot.recipeOrigins.get('shared-two')).toEqual({
      kind: 'shared',
      ownerSub: 'shared-owner',
    });
    expect(snapshot.collections.get('collection-collision')?.name).toBe('Owned collection');
    expect(snapshot.collectionOrigins.get('collection-collision')).toEqual({ kind: 'own' });
    expect(snapshot.collections.get('shared-collection')?.name).toBe('Shared collection');
    expect(snapshot.collectionOrigins.get('shared-collection')).toEqual({
      kind: 'shared',
      ownerSub: 'shared-owner',
    });
    expect([...snapshot.remotePhotoIds]).toEqual([
      'owned-photo',
      'shared-photo-one',
      'shared-photo-two',
    ]);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
    expect(snapshot.grantCounts.get('collection-collision')).toBe(3);
    expect(snapshot.loaded).toBe(true);
  });

  it('publishes a stable reread once and drops the page staged before restart', async () => {
    addPendingBlob('pending-photo', new Blob(['pending']));
    setGrantCount('known-grants', 2);
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });
    let ownedCalls = 0;
    const cursors: Array<string | null> = [];
    const result = await pullAll({
      pullPage: async () => {
        ownedCalls += 1;
        return ownedPage(
          ownedChanges({ recipes: [pullDoc(recipe('owned', 'Owned'))] }),
        );
      },
      pullSharedPage: async (cursor) => {
        cursors.push(cursor);
        if (cursors.length === 1) {
          return sharedPage(
            {
              recipes: [
                { ...recipe('revoked-recipe', 'Revoked'), ownerSub: 'owner' },
              ],
              collections: [
                {
                  ...collection('revoked-collection', 'Revoked'),
                  ownerSub: 'owner',
                },
              ],
              photos: [{ id: 'revoked-photo' }],
            },
            { hasMore: true, cursorToken: 'revoked-page' },
          );
        }
        if (cursors.length === 2) {
          return 'restart';
        }
        if (cursors.length === 3) {
          return sharedPage(
            {
              recipes: [{ ...recipe('kept-one', 'Kept one'), ownerSub: 'owner' }],
            },
            { hasMore: true, cursorToken: 'stable-page' },
          );
        }
        return sharedPage({
          recipes: [{ ...recipe('kept-two', 'Kept two'), ownerSub: 'owner' }],
          photos: [{ id: 'kept-photo' }],
        });
      },
    });
    unsubscribe();

    const snapshot = getSnapshot();
    expect(result).toEqual({ outcome: 'ok', pushed: 0, applied: 0 });
    expect(ownedCalls).toBe(1);
    expect(cursors).toEqual([null, 'revoked-page', null, 'stable-page']);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe(snapshot);
    expect([...snapshot.recipes.keys()]).toEqual(['owned', 'kept-one', 'kept-two']);
    expect(snapshot.recipes.has('revoked-recipe')).toBe(false);
    expect(snapshot.collections.has('revoked-collection')).toBe(false);
    expect(snapshot.recipeOrigins.has('revoked-recipe')).toBe(false);
    expect(snapshot.remotePhotoIds.has('revoked-photo')).toBe(false);
    expect(snapshot.remotePhotoIds.has('kept-photo')).toBe(true);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
    expect(snapshot.grantCounts.get('known-grants')).toBe(2);
  });

  it('discards a staged recipe when membership changes and the pull restarts', async () => {
    const cursors: Array<string | null> = [];
    const result = await pullAll({
      pullPage: async () =>
        ownedPage(ownedChanges({ recipes: [pullDoc(recipe('owned', 'Owned'))] })),
      pullSharedPage: async (cursor) => {
        cursors.push(cursor);
        if (cursors.length === 1) {
          return sharedPage(
            {
              recipes: [
                { ...recipe('removed-recipe', 'Removed'), ownerSub: 'owner' },
              ],
              photos: [{ id: 'removed-photo' }],
            },
            { hasMore: true, cursorToken: 'page-one' },
          );
        }
        if (cursors.length === 2) {
          return 'restart';
        }
        return sharedPage({
          recipes: [{ ...recipe('remaining-recipe', 'Remaining'), ownerSub: 'owner' }],
        });
      },
    });

    const snapshot = getSnapshot();
    expect(result.outcome).toBe('ok');
    expect(cursors).toEqual([null, 'page-one', null]);
    expect([...snapshot.recipes.keys()]).toEqual(['owned', 'remaining-recipe']);
    expect(snapshot.recipes.has('removed-recipe')).toBe(false);
    expect(snapshot.recipeOrigins.has('removed-recipe')).toBe(false);
    expect(snapshot.remotePhotoIds.has('removed-photo')).toBe(false);
  });

  it('installs owned-only state when shared scope churn exhausts the retry cap', async () => {
    replaceFromPull({
      recipes: new Map([['prior-owned', recipe('prior-owned', 'Prior owned')]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(['prior-owned-photo']),
    });
    mergeSharedFromPull({
      recipes: new Map([['prior-shared', recipe('prior-shared', 'Prior shared')]]),
      collections: new Map([
        ['prior-shared-collection', collection('prior-shared-collection', 'Prior')],
      ]),
      remotePhotoIds: new Set(['prior-shared-photo']),
      recipeOrigins: new Map([
        ['prior-shared', { kind: 'shared', ownerSub: 'prior-owner' }],
      ]),
      collectionOrigins: new Map([
        ['prior-shared-collection', { kind: 'shared', ownerSub: 'prior-owner' }],
      ]),
    });
    addPendingBlob('pending-photo', new Blob(['pending']));
    setGrantCount('known-grants', 4);
    const emissions: ReturnType<typeof getSnapshot>[] = [];
    const unsubscribe = subscribe(() => {
      emissions.push(getSnapshot());
    });
    let ownedCalls = 0;
    const cursors: Array<string | null> = [];
    const result = await pullAll({
      pullPage: async () => {
        ownedCalls += 1;
        return ownedPage(
          ownedChanges({
            recipes: [pullDoc(recipe('new-own', 'New owned'))],
            photos: [{ id: 'new-owned-photo' }],
          }),
        );
      },
      pullSharedPage: async (cursor) => {
        cursors.push(cursor);
        if ((cursors.length - 1) % 2 === 0) {
          return sharedPage(
            {
              recipes: [
                { ...recipe('staged-shared', 'Staged'), ownerSub: 'owner' },
              ],
              photos: [{ id: 'staged-photo' }],
            },
            { hasMore: true, cursorToken: 'staged-cursor' },
          );
        }
        return 'restart';
      },
    });
    unsubscribe();

    const snapshot = getSnapshot();
    expect(result).toEqual({ outcome: 'error', pushed: 0, applied: 0 });
    expect(decideSyncToast(result)).toEqual({
      kind: 'error',
      message: "Couldn't refresh",
    });
    expect(ownedCalls).toBe(1);
    expect(cursors).toEqual(
      Array.from({ length: MAX_SHARED_PULL_ATTEMPTS }, () => [
        null,
        'staged-cursor',
      ]).flat(),
    );
    expect(emissions).toHaveLength(1);
    expect([...snapshot.recipes.keys()]).toEqual(['new-own']);
    expect(snapshot.recipes.has('staged-shared')).toBe(false);
    expect(snapshot.recipes.has('prior-shared')).toBe(false);
    expect(snapshot.collections.has('prior-shared-collection')).toBe(false);
    expect(snapshot.remotePhotoIds.has('staged-photo')).toBe(false);
    expect(snapshot.remotePhotoIds.has('prior-shared-photo')).toBe(false);
    expect([...snapshot.remotePhotoIds]).toEqual(['new-owned-photo']);
    expect(snapshot.recipeOrigins.has('staged-shared')).toBe(false);
    expect(snapshot.recipeOrigins.has('prior-shared')).toBe(false);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
    expect(snapshot.grantCounts.get('known-grants')).toBe(4);
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
