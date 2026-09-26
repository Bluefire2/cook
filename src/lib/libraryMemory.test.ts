import { afterEach, describe, expect, it } from 'vitest';
import {
  addPendingBlob,
  captureSnapshot,
  chatParentIsShared,
  clearChatLocal,
  clearLibrary,
  cookParentIsShared,
  countOwnedNamedCollections,
  getRecipe,
  getSnapshot,
  isSharedRecipe,
  mergeSharedFromPull,
  ownedBackupGraphIds,
  removeRecipeLocal,
  replaceFromPull,
  replaceFromPullWithShared,
  restoreSnapshot,
  setGrantCount,
  subscribe,
  upsertChat,
  upsertCollection,
  upsertCook,
  upsertRecipe,
} from './libraryMemory';
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
    updatedAt: 1,
  };
}

afterEach(() => {
  clearLibrary();
});

describe('mergeSharedFromPull', () => {
  it('adds a shared recipe and refuses to overwrite an owned id', () => {
    const own = recipe('own-1', 'Mine');
    replaceFromPull({
      recipes: new Map([[own.id, own]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });
    const collision = recipe('own-1', 'Theirs');
    const shared = recipe('shared-1', 'Shared soup');
    mergeSharedFromPull({
      recipes: new Map([
        [collision.id, collision],
        [shared.id, shared],
      ]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [collision.id, { kind: 'shared', ownerSub: 'owner' }],
        [shared.id, { kind: 'shared', ownerSub: 'owner' }],
      ]),
      collectionOrigins: new Map(),
    });
    expect(getRecipe('own-1')?.title).toBe('Mine');
    expect(isSharedRecipe('own-1')).toBe(false);
    expect(getRecipe('shared-1')?.title).toBe('Shared soup');
    expect(isSharedRecipe('shared-1')).toBe(true);
  });

  it('marks a locally created recipe as owned', () => {
    upsertRecipe(recipe('new-1', 'Fresh'));
    expect(isSharedRecipe('new-1')).toBe(false);
  });
});

describe('replaceFromPullWithShared', () => {
  it('publishes one complete owned-precedence snapshot and preserves local caches', () => {
    addPendingBlob('pending-photo', new Blob(['pending']));
    setGrantCount('owned-collection', 2);
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });

    replaceFromPullWithShared(
      {
        recipes: new Map([['collision', recipe('collision', 'Mine')]]),
        collections: new Map([
          ['owned-collection', collection('owned-collection', 'Mine')],
        ]),
        chat: new Map(),
        cook: new Map(),
        remotePhotoIds: new Set(['owned-photo']),
      },
      {
        recipes: new Map([
          ['collision', recipe('collision', 'Theirs')],
          ['shared-recipe', recipe('shared-recipe', 'Shared')],
        ]),
        collections: new Map([
          ['shared-collection', collection('shared-collection', 'Shared')],
        ]),
        remotePhotoIds: new Set(['shared-photo']),
        recipeOrigins: new Map([
          ['collision', { kind: 'shared', ownerSub: 'owner' }],
          ['shared-recipe', { kind: 'shared', ownerSub: 'owner' }],
        ]),
        collectionOrigins: new Map([
          ['shared-collection', { kind: 'shared', ownerSub: 'owner' }],
        ]),
      },
    );
    unsubscribe();

    const snapshot = getSnapshot();
    expect(calls).toBe(1);
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.recipes.get('collision')?.title).toBe('Mine');
    expect(snapshot.recipeOrigins.get('collision')).toEqual({ kind: 'own' });
    expect(snapshot.recipeOrigins.get('shared-recipe')).toEqual({
      kind: 'shared',
      ownerSub: 'owner',
    });
    expect(snapshot.collectionOrigins.get('owned-collection')).toEqual({
      kind: 'own',
    });
    expect(snapshot.collectionOrigins.get('shared-collection')).toEqual({
      kind: 'shared',
      ownerSub: 'owner',
    });
    expect([...snapshot.remotePhotoIds]).toEqual(['owned-photo', 'shared-photo']);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
    expect(snapshot.grantCounts.get('owned-collection')).toBe(2);
  });
});

function collection(id: string, name: string): Collection {
  return {
    id,
    name,
    recipeIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('setGrantCount', () => {
  it('distinguishes an unknown count from known zero and positive counts', () => {
    expect(getSnapshot().grantCounts.get('col-1')).toBeUndefined();
    setGrantCount('col-1', 0);
    expect(getSnapshot().grantCounts.get('col-1')).toBe(0);
    setGrantCount('col-1', 2);
    expect(getSnapshot().grantCounts.get('col-1')).toBe(2);
  });

  it('does not notify subscribers when the count is unchanged', () => {
    let calls = 0;
    const unsub = subscribe(() => {
      calls += 1;
    });
    setGrantCount('col-1', 2);
    expect(calls).toBe(1);
    setGrantCount('col-1', 2);
    expect(calls).toBe(1);
    setGrantCount('col-1', 3);
    expect(calls).toBe(2);
    unsub();
  });
});

describe('countOwnedNamedCollections', () => {
  it('counts only owned and missing-origin collections', () => {
    replaceFromPull({
      recipes: new Map(),
      collections: new Map([
        ['owned-a', collection('owned-a', 'A')],
        ['owned-b', collection('owned-b', 'B')],
      ]),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });
    expect(countOwnedNamedCollections()).toBe(2);

    mergeSharedFromPull({
      recipes: new Map(),
      collections: new Map([['shared-1', collection('shared-1', 'Shared')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([
        ['shared-1', { kind: 'shared', ownerSub: 'alice' }],
      ]),
    });
    expect(countOwnedNamedCollections()).toBe(2);

    upsertCollection(collection('owned-c', 'C'));
    expect(countOwnedNamedCollections()).toBe(3);
  });
});

function message(id: string, recipeId: string): ChatMessage {
  return {
    id,
    recipeId,
    role: 'user',
    content: 'hi',
    createdAt: 3,
    photoIds: ['photo-1'],
  };
}

function cookRow(recipeId: string): CookStateRow {
  return {
    recipeId,
    servings: 2,
    currentStep: 0,
    checkedKeys: [],
    recipeUpdatedAt: 1,
  };
}

describe('chat and cook parent sidecars', () => {
  it('publishes owned sidecars and keeps them beside a shared recipe', () => {
    replaceFromPullWithShared(
      {
        recipes: new Map([['mine', recipe('mine', 'Mine')]]),
        collections: new Map(),
        chat: new Map([['m', message('m', 'revoked')]]),
        cook: new Map([['revoked', cookRow('revoked')]]),
        remotePhotoIds: new Set(),
        chatParentOrigins: new Map([['m', 'owner-sub']]),
        cookParentOrigins: new Map([['revoked', 'owner-sub']]),
      },
      {
        recipes: new Map([['shared', recipe('shared', 'Shared')]]),
        collections: new Map(),
        remotePhotoIds: new Set(),
        recipeOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'owner-sub' }]]),
        collectionOrigins: new Map(),
      },
    );
    const snapshot = getSnapshot();
    expect(snapshot.chatParentOrigins.get('m')).toBe('owner-sub');
    expect(snapshot.cookParentOrigins.get('revoked')).toBe('owner-sub');
    expect(snapshot.recipeOrigins.get('mine')).toEqual({ kind: 'own' });
    expect(snapshot.recipeOrigins.get('shared')).toEqual({
      kind: 'shared',
      ownerSub: 'owner-sub',
    });
    expect(snapshot.recipeOrigins.has('revoked')).toBe(false);
    expect(chatParentIsShared('m', 'revoked')).toBe(true);
    expect(cookParentIsShared('revoked')).toBe(true);
  });

  it('infers a sidecar from a live shared origin and clears it for an owned origin', () => {
    mergeSharedFromPull({
      recipes: new Map([['shared', recipe('shared', 'Shared')]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map(),
    });
    upsertChat(message('shared-message', 'shared'));
    upsertCook(cookRow('shared'));
    expect(getSnapshot().chatParentOrigins.get('shared-message')).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('shared')).toBe('alice');

    const ownedMessage = message('owned-message', 'owned');
    replaceFromPull({
      recipes: new Map([['owned', recipe('owned', 'Mine')]]),
      collections: new Map(),
      chat: new Map([[ownedMessage.id, ownedMessage]]),
      cook: new Map([['owned', cookRow('owned')]]),
      remotePhotoIds: new Set(),
      chatParentOrigins: new Map([[ownedMessage.id, 'stale-owner']]),
      cookParentOrigins: new Map([['owned', 'stale-owner']]),
    });
    upsertChat(ownedMessage);
    upsertCook(cookRow('owned'));
    expect(getSnapshot().chatParentOrigins.has(ownedMessage.id)).toBe(false);
    expect(getSnapshot().cookParentOrigins.has('owned')).toBe(false);
  });

  it('keeps a persisted sidecar when a rewrite happens after the recipe origin is gone', () => {
    const revokedMessage = message('revoked-message', 'revoked');
    replaceFromPull({
      recipes: new Map(),
      collections: new Map(),
      chat: new Map([[revokedMessage.id, revokedMessage]]),
      cook: new Map([['revoked', cookRow('revoked')]]),
      remotePhotoIds: new Set(),
      chatParentOrigins: new Map([[revokedMessage.id, 'alice']]),
      cookParentOrigins: new Map([['revoked', 'alice']]),
    });
    upsertChat({ ...revokedMessage, content: 'edited' });
    upsertCook({ ...cookRow('revoked'), servings: 4 });
    expect(getSnapshot().chatParentOrigins.get(revokedMessage.id)).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('revoked')).toBe('alice');
    expect(getSnapshot().recipeOrigins.has('revoked')).toBe(false);
  });

  it('removes sidecar state on clear, recipe removal, and sign-out', () => {
    const revokedMessage = message('revoked-message', 'revoked');
    replaceFromPull({
      recipes: new Map([['revoked', recipe('revoked', 'Gone')]]),
      collections: new Map(),
      chat: new Map([
        [revokedMessage.id, revokedMessage],
        ['other', message('other', 'other-recipe')],
      ]),
      cook: new Map([['revoked', cookRow('revoked')]]),
      remotePhotoIds: new Set(),
      chatParentOrigins: new Map([
        [revokedMessage.id, 'alice'],
        ['other', 'alice'],
      ]),
      cookParentOrigins: new Map([['revoked', 'alice']]),
    });

    const captured = captureSnapshot();
    clearChatLocal('revoked');
    expect(getSnapshot().chat.has(revokedMessage.id)).toBe(false);
    expect(getSnapshot().chatParentOrigins.has(revokedMessage.id)).toBe(false);
    expect(getSnapshot().chatParentOrigins.get('other')).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('revoked')).toBe('alice');

    restoreSnapshot(captured);
    expect(getSnapshot().chatParentOrigins.get(revokedMessage.id)).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('revoked')).toBe('alice');

    removeRecipeLocal('revoked');
    expect(getSnapshot().chatParentOrigins.has(revokedMessage.id)).toBe(false);
    expect(getSnapshot().cookParentOrigins.has('revoked')).toBe(false);
    expect(getSnapshot().chatParentOrigins.get('other')).toBe('alice');

    clearLibrary();
    expect(getSnapshot().chatParentOrigins.size).toBe(0);
    expect(getSnapshot().cookParentOrigins.size).toBe(0);
    expect(getSnapshot().loaded).toBe(true);
  });

  it('excludes revoked shared-parent rows from owned overlap and keeps legacy orphans', () => {
    replaceFromPull({
      recipes: new Map([['owned', recipe('owned', 'Mine')]]),
      collections: new Map(),
      chat: new Map([
        ['revoked-chat', { ...message('revoked-chat', 'revoked'), photoIds: ['revoked-photo'] }],
        ['orphan-chat', { ...message('orphan-chat', 'missing'), photoIds: ['orphan-photo'] }],
        ['owned-chat', message('owned-chat', 'owned')],
      ]),
      cook: new Map([
        ['revoked', cookRow('revoked')],
        ['missing', cookRow('missing')],
        ['owned', cookRow('owned')],
      ]),
      remotePhotoIds: new Set(['revoked-photo']),
      chatParentOrigins: new Map([['revoked-chat', 'former-owner']]),
      cookParentOrigins: new Map([['revoked', 'former-owner']]),
    });

    const ids = ownedBackupGraphIds();
    expect(ids.chatMessageIds.has('revoked-chat')).toBe(false);
    expect(ids.recipeIds.has('revoked')).toBe(false);
    expect(ids.photoIds.has('revoked-photo')).toBe(false);
    expect(ids.chatMessageIds.has('orphan-chat')).toBe(true);
    expect(ids.recipeIds.has('missing')).toBe(true);
    expect(ids.photoIds.has('orphan-photo')).toBe(true);
    expect(ids.chatMessageIds.has('owned-chat')).toBe(true);
    expect(ids.recipeIds.has('owned')).toBe(true);
    expect(ids.photoIds.has('photo-1')).toBe(true);
    expect(chatParentIsShared('orphan-chat', 'missing')).toBe(false);
    expect(cookParentIsShared('missing')).toBe(false);
    expect(chatParentIsShared('owned-chat', 'owned')).toBe(false);
  });
});
