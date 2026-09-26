import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_NAMED_COLLECTIONS } from './compactCollection';
import { collectionPushErrorMessage, collectionStore } from './collectionStore';
import {
  clearLibrary,
  countOwnedNamedCollections,
  listCollections,
  mergeSharedFromPull,
  upsertCollection,
} from './libraryMemory';
import {
  addCollectionGrant,
  listCollectionGrants,
  pushOps,
  revokeCollectionGrant,
} from './remote';
import type { CollectionGrant } from './remote';
import type { Collection } from './types';

vi.mock('./remote', () => ({
  addCollectionGrant: vi.fn(),
  listCollectionGrants: vi.fn(),
  pushOps: vi.fn(),
  revokeCollectionGrant: vi.fn(),
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
  vi.mocked(listCollectionGrants).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.mocked(revokeCollectionGrant).mockReset();
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

    mergeSharedFromPull({
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
    mergeSharedFromPull({
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
    expect(addCollectionGrant).toHaveBeenCalledWith('collection-id', grant.email);
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
