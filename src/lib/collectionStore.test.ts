import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_NAMED_COLLECTIONS } from './compactCollection';
import { collectionPushErrorMessage, collectionStore } from './collectionStore';
import {
  clearLibrary,
  countOwnedNamedCollections,
  getCollection,
  listCollections,
  removeCollectionLocal,
  upsertCollection,
} from './libraryMemory';
import { recipeStore } from './recipeStore';
import { installSharedRows } from './testLibrary';
import {
  addCollectionGrant,
  leaveSharedCollection,
  listCollectionGrants,
  pushOps,
  revokeCollectionGrant,
} from './remote';
import { pullAfterLocalWrite } from './syncEngine';
import type { CollectionGrant } from './remote';
import type { Collection } from './types';

vi.mock('./remote', () => ({
  addCollectionGrant: vi.fn(),
  leaveSharedCollection: vi.fn(),
  listCollectionGrants: vi.fn(),
  pushOps: vi.fn(),
  revokeCollectionGrant: vi.fn(),
}));

vi.mock('./syncEngine', () => ({
  localWriteOverlapsPull: vi.fn(() => false),
  pullAfterLocalWrite: vi.fn(),
}));

function collection(id: string, name: string): Collection {
  return {
    id,
    name,
    recipeIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  clearLibrary();
  vi.mocked(addCollectionGrant).mockReset();
  vi.mocked(leaveSharedCollection).mockReset();
  vi.mocked(listCollectionGrants).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.mocked(revokeCollectionGrant).mockReset();
  vi.mocked(pullAfterLocalWrite).mockReset();
});

describe('collectionPushErrorMessage', () => {
  it('uses the cap copy only for the dedicated cap reason on create', () => {
    expect(collectionPushErrorMessage('cap', true)).toBe(
      `You can have up to ${MAX_NAMED_COLLECTIONS} collections.`,
    );
    expect(collectionPushErrorMessage('invalid', true)).toBe(
      "Couldn't save the collection.",
    );
    expect(collectionPushErrorMessage('unknown', true)).toBe(
      "Couldn't save the collection.",
    );
    expect(collectionPushErrorMessage('cap', false)).toBe(
      "Couldn't save the collection.",
    );
  });

  it('keeps the signed-out copy', () => {
    expect(collectionPushErrorMessage('signedOut', true)).toBe(
      'Please sign in again — your session expired.',
    );
  });
});

describe('collectionStore.create cap', () => {
  it('counts only owned collections against the client cap', async () => {
    for (let i = 0; i < MAX_NAMED_COLLECTIONS - 1; i += 1) {
      upsertCollection(collection(`owned-${i}`, `Owned ${i}`));
    }
    expect(countOwnedNamedCollections()).toBe(MAX_NAMED_COLLECTIONS - 1);

    installSharedRows({
      recipes: new Map(),
      collections: new Map([
        ['shared-a', collection('shared-a', 'Shared A')],
        ['shared-b', collection('shared-b', 'Shared B')],
      ]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([
        ['shared-a', { kind: 'shared', ownerSub: 'alice' }],
        ['shared-b', { kind: 'shared', ownerSub: 'bob' }],
      ]),
    });
    expect(listCollections().length).toBeGreaterThanOrEqual(MAX_NAMED_COLLECTIONS);

    vi.mocked(pushOps).mockResolvedValue('ok');
    const created = await collectionStore.create('New owned');
    expect(created.name).toBe('New owned');
    expect(countOwnedNamedCollections()).toBe(MAX_NAMED_COLLECTIONS);
  });

  it('rejects create when owned count is already at the cap', async () => {
    for (let i = 0; i < MAX_NAMED_COLLECTIONS; i += 1) {
      upsertCollection(collection(`owned-${i}`, `Owned ${i}`));
    }
    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared-only', collection('shared-only', 'Shared')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared-only', { kind: 'shared', ownerSub: 'alice' }]]),
    });

    await expect(collectionStore.create('One more')).rejects.toThrow(
      `You can have up to ${MAX_NAMED_COLLECTIONS} collections.`,
    );
    expect(pushOps).not.toHaveBeenCalled();
  });
});

describe('read-only selectors', () => {
  it('report shared origin for incoming rows and owned for local rows', () => {
    upsertCollection(collection('owned', 'Mine'));
    installSharedRows({
      recipes: new Map([
        [
          'shared-recipe',
          {
            id: 'shared-recipe',
            title: 'Theirs',
            servings: 1,
            ingredientSections: [],
            steps: [],
            tags: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      ]),
      collections: new Map([['shared', collection('shared', 'Theirs')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['shared-recipe', { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map([
        ['shared', { kind: 'shared', ownerSub: 'alice', ownerEmail: 'alice@example.com' }],
      ]),
    });

    expect(collectionStore.sharedBy('shared')).toBe('alice@example.com');
    expect(collectionStore.sharedBy('owned')).toBeUndefined();
    expect(collectionStore.isShared('shared')).toBe(true);
    expect(collectionStore.isShared('owned')).toBe(false);
    expect(recipeStore.isShared('shared-recipe')).toBe(true);
    expect(recipeStore.isShared('missing')).toBe(false);
  });
});

describe('collectionStore grant mutations', () => {
  it('adds a grant without listing grants internally', async () => {
    const grant: CollectionGrant = {
      sub: 'member-sub',
      email: 'member@example.com',
      createdAt: 123,
    };
    vi.mocked(addCollectionGrant).mockResolvedValue({ kind: 'ok', grant });

    await expect(collectionStore.addGrant('collection-id', grant.email)).resolves.toEqual(grant);

    expect(addCollectionGrant).toHaveBeenCalledTimes(1);
    expect(addCollectionGrant).toHaveBeenCalledWith('collection-id', grant.email, 'viewer');
    expect(listCollectionGrants).not.toHaveBeenCalled();
  });

  it('revokes a grant without listing grants internally', async () => {
    vi.mocked(revokeCollectionGrant).mockResolvedValue({ kind: 'ok' });

    await expect(
      collectionStore.revokeGrant('collection-id', 'member-sub'),
    ).resolves.toBeUndefined();

    expect(revokeCollectionGrant).toHaveBeenCalledTimes(1);
    expect(revokeCollectionGrant).toHaveBeenCalledWith('collection-id', 'member-sub');
    expect(listCollectionGrants).not.toHaveBeenCalled();
  });
});

describe('collectionStore.leave', () => {
  function installShared() {
    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared', collection('shared', 'Theirs')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
    });
  }

  it('refuses to leave an owned collection', async () => {
    upsertCollection(collection('owned', 'Mine'));

    await expect(collectionStore.leave('owned')).rejects.toThrow(
      'This collection is not shared with you.',
    );
    expect(leaveSharedCollection).not.toHaveBeenCalled();
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('refuses to leave an unknown collection id', async () => {
    await expect(collectionStore.leave('does-not-exist')).rejects.toThrow(
      'This collection is not shared with you.',
    );
    expect(leaveSharedCollection).not.toHaveBeenCalled();
  });

  it('leaves a shared collection by its owner sub and rereads the server', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'ok' });
    let presentBeforePull: boolean | undefined;
    vi.mocked(pullAfterLocalWrite).mockImplementation(async () => {
      // The collection stays until the pull publishes state without it.
      presentBeforePull = getCollection('shared') !== undefined;
      removeCollectionLocal('shared');
      return 'ok';
    });

    await expect(collectionStore.leave('shared')).resolves.toBeUndefined();

    expect(leaveSharedCollection).toHaveBeenCalledTimes(1);
    expect(leaveSharedCollection).toHaveBeenCalledWith('alice', 'shared');
    expect(presentBeforePull).toBe(true);
    expect(getCollection('shared')).toBeUndefined();
    expect(pullAfterLocalWrite).toHaveBeenCalledTimes(1);
    expect(pullAfterLocalWrite).toHaveBeenCalledWith(expect.any(Number));
  });

  it('throws and keeps the collection when the follow-up pull fails', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'ok' });
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('error');

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      "Couldn't refresh after leaving.",
    );
    expect(getCollection('shared')).toBeDefined();
  });

  it('treats a signed-out follow-up pull as a sign-in error', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'ok' });
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('signedOut');

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
  });

  it('surfaces a signed-out leave result without pulling', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'signedOut' });

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('surfaces a server error without pulling', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({
      kind: 'error',
      message: "Couldn't leave the collection.",
    });

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      "Couldn't leave the collection.",
    );
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });
});
