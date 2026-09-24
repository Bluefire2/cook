import { afterEach, describe, expect, it, vi } from 'vitest';
import { importLibrary } from './backup';
import {
  clearLibrary,
  getSnapshot,
  listAllChat,
  listAllCook,
  listCollections,
  listRecipes,
  mergeSharedFromPull,
  replaceFromPull,
} from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import type { PushOp } from './pushOps';

vi.mock('./remote', () => ({
  fetchPhotoBlob: vi.fn(),
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

const RECIPE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

const COLLECTION = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Dinners',
  recipeIds: [RECIPE.id],
  createdAt: 1,
  updatedAt: 2,
};

const PHOTO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHAT = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  recipeId: RECIPE.id,
  role: 'user' as const,
  content: 'How long?',
  photoIds: [PHOTO],
  createdAt: 3,
};
const COOK = {
  recipeId: RECIPE.id,
  servings: 2,
  currentStep: 0,
  checkedKeys: ['0:0'],
  recipeUpdatedAt: RECIPE.updatedAt,
};

function backupFile(exportedBySub?: string): File {
  return new File(
    [
      JSON.stringify({
        app: 'cook',
        version: 3,
        exportedAt: 3,
        ...(exportedBySub === undefined ? {} : { exportedBySub }),
        recipes: [{ ...RECIPE, photoId: PHOTO }],
        chatMessages: [CHAT],
        photos: [
          {
            id: PHOTO,
            type: 'image/jpeg',
            base64: 'YQ==',
            createdAt: 3,
          },
        ],
        cookState: [COOK],
        collections: [COLLECTION],
      }),
    ],
    'cook-backup.json',
    { type: 'application/json' },
  );
}

function lastPushedOps(): PushOp[] {
  return vi.mocked(pushOps).mock.calls.at(-1)?.[0] ?? [];
}

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
  vi.mocked(postPhoto).mockReset();
});

describe('importLibrary', () => {
  it('rolls back local upserts when pushOps rejects', async () => {
    vi.mocked(pushOps).mockResolvedValue('error');
    const file = new File(
      [
        JSON.stringify({
          app: 'cook',
          version: 3,
          exportedAt: 3,
          recipes: [RECIPE],
          chatMessages: [],
          photos: [],
          collections: [COLLECTION],
        }),
      ],
      'cook-backup.json',
      { type: 'application/json' },
    );

    await expect(importLibrary(file, 'test-sub')).rejects.toThrow("Couldn't import the backup.");
    expect(listRecipes()).toEqual([]);
    expect(listCollections()).toEqual([]);
  });

  it('preserves a populated same-account legacy graph and stays idempotent by ID', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');
    replaceFromPull({
      recipes: new Map([[RECIPE.id, { ...RECIPE, title: 'Older soup' }]]),
      collections: new Map([[COLLECTION.id, COLLECTION]]),
      chat: new Map([[CHAT.id, CHAT]]),
      cook: new Map([[COOK.recipeId, COOK]]),
      remotePhotoIds: new Set([PHOTO]),
    });

    await importLibrary(backupFile(), 'alice-sub');
    await importLibrary(backupFile(), 'alice-sub');

    expect(listRecipes()).toHaveLength(1);
    expect(listRecipes()[0]).toMatchObject({ id: RECIPE.id, title: 'Soup', photoId: PHOTO });
    expect(listCollections()).toEqual([COLLECTION]);
    expect(listAllChat()).toEqual([CHAT]);
    expect(listAllCook()).toEqual([COOK]);
    expect(vi.mocked(postPhoto).mock.calls.at(-1)?.slice(0, 2)).toEqual([
      PHOTO,
      RECIPE.id,
    ]);
  });

  it('clones one complete legacy graph on an empty account', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');

    await importLibrary(backupFile(), 'alice-sub');

    const recipe = listRecipes()[0]!;
    const collection = listCollections()[0]!;
    const chat = listAllChat()[0]!;
    const cook = listAllCook()[0]!;
    const photoId = recipe.photoId!;
    expect(recipe.id).not.toBe(RECIPE.id);
    expect(collection.id).not.toBe(COLLECTION.id);
    expect(chat.id).not.toBe(CHAT.id);
    expect(photoId).not.toBe(PHOTO);
    expect(collection.recipeIds).toEqual([recipe.id]);
    expect(chat.recipeId).toBe(recipe.id);
    expect(chat.photoIds).toEqual([photoId]);
    expect(cook.recipeId).toBe(recipe.id);
    expect(vi.mocked(postPhoto).mock.calls[0]?.slice(0, 2)).toEqual([
      photoId,
      recipe.id,
    ]);
  });

  it('does not treat shared-only legacy overlap as owned evidence', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');
    const sharedRecipe = { ...RECIPE, title: 'Shared original', photoId: PHOTO };
    mergeSharedFromPull({
      recipes: new Map([[RECIPE.id, sharedRecipe]]),
      collections: new Map([[COLLECTION.id, COLLECTION]]),
      remotePhotoIds: new Set([PHOTO]),
      recipeOrigins: new Map([
        [RECIPE.id, { kind: 'shared', ownerSub: 'alice-sub' }],
      ]),
      collectionOrigins: new Map([
        [COLLECTION.id, { kind: 'shared', ownerSub: 'alice-sub' }],
      ]),
    });

    await importLibrary(backupFile(), 'carol-sub');

    const importedRecipe = listRecipes().find((recipe) => recipe.title === 'Soup')!;
    const importedCollection = listCollections().find(
      (collection) => collection.id !== COLLECTION.id,
    )!;
    const importedChat = listAllChat()[0]!;
    const importedCook = listAllCook()[0]!;
    expect(importedRecipe.id).not.toBe(RECIPE.id);
    expect(importedRecipe.photoId).not.toBe(PHOTO);
    expect(importedCollection.recipeIds).toEqual([importedRecipe.id]);
    expect(importedChat.recipeId).toBe(importedRecipe.id);
    expect(importedChat.photoIds).toEqual([importedRecipe.photoId]);
    expect(importedCook.recipeId).toBe(importedRecipe.id);
    expect(getSnapshot().recipes.get(RECIPE.id)?.title).toBe('Shared original');
  });

  it('clones explicit foreign provenance despite an owned collision', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');
    replaceFromPull({
      recipes: new Map([[RECIPE.id, { ...RECIPE, title: 'Carol soup' }]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });

    await importLibrary(backupFile('alice-sub'), 'carol-sub');

    const recipePut = lastPushedOps().find((op) => op.kind === 'recipe.put');
    expect(recipePut?.payload.id).not.toBe(RECIPE.id);
    expect(getSnapshot().recipes.get(RECIPE.id)?.title).toBe('Carol soup');
    expect(listRecipes()).toHaveLength(2);
  });
});
