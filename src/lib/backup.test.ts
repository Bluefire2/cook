import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportLibrary, importLibrary } from './backup';
import {
  addPendingBlob,
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

function installFileReader(): void {
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | null = null;
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(blob: Blob): void {
        void blob
          .arrayBuffer()
          .then((buffer) => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onload?.();
          })
          .catch((error: unknown) => {
            this.error = error;
            this.onerror?.();
          });
      }
    },
  );
}

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
  vi.unstubAllGlobals();
  vi.mocked(pushOps).mockReset();
  vi.mocked(postPhoto).mockReset();
});

describe('exportLibrary', () => {
  it('omits shared-parent chat, cook state, and chat-only photos', async () => {
    installFileReader();
    const ownedRecipePhotoId = 'owned-recipe-photo';
    const sharedRecipePhotoId = 'shared-recipe-photo';
    const ownedChatPhotoId = 'owned-chat-photo';
    const sharedChatPhotoId = 'shared-chat-photo';
    const orphanChatPhotoId = 'orphan-chat-photo';
    const sharedRecipe = {
      ...RECIPE,
      id: 'shared-recipe',
      title: 'Shared soup',
      photoId: sharedRecipePhotoId,
    };
    const ownedRecipe = { ...RECIPE, photoId: ownedRecipePhotoId };
    const ownedChat = { ...CHAT, photoIds: [ownedChatPhotoId] };
    const sharedChat = {
      ...CHAT,
      id: 'shared-chat',
      recipeId: sharedRecipe.id,
      photoIds: [sharedChatPhotoId],
    };
    const orphanChat = {
      ...CHAT,
      id: 'orphan-chat',
      recipeId: 'missing-recipe',
      photoIds: [orphanChatPhotoId],
    };
    const sharedCook = { ...COOK, recipeId: sharedRecipe.id };
    const orphanCook = { ...COOK, recipeId: 'missing-recipe' };

    replaceFromPull({
      recipes: new Map([[ownedRecipe.id, ownedRecipe]]),
      collections: new Map([[COLLECTION.id, COLLECTION]]),
      chat: new Map([
        [ownedChat.id, ownedChat],
        [sharedChat.id, sharedChat],
        [orphanChat.id, orphanChat],
      ]),
      cook: new Map([
        [COOK.recipeId, COOK],
        [sharedCook.recipeId, sharedCook],
        [orphanCook.recipeId, orphanCook],
      ]),
      remotePhotoIds: new Set(),
    });
    mergeSharedFromPull({
      recipes: new Map([[sharedRecipe.id, sharedRecipe]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [sharedRecipe.id, { kind: 'shared', ownerSub: 'owner-sub' }],
      ]),
      collectionOrigins: new Map(),
    });
    for (const id of [
      ownedRecipePhotoId,
      sharedRecipePhotoId,
      ownedChatPhotoId,
      sharedChatPhotoId,
      orphanChatPhotoId,
    ]) {
      addPendingBlob(id, new Blob([id], { type: 'image/jpeg' }));
    }

    const backup = JSON.parse(
      await (await exportLibrary('viewer-sub')).text(),
    ) as Record<string, unknown>;

    expect(backup).toMatchObject({
      app: 'cook',
      version: 3,
      exportedBySub: 'viewer-sub',
    });
    expect(backup.recipes).toEqual([ownedRecipe]);
    expect(backup.chatMessages).toEqual([ownedChat, orphanChat]);
    expect(backup.cookState).toEqual([COOK, orphanCook]);
    expect(backup.collections).toEqual([COLLECTION]);
    expect(backup.recipes).not.toContainEqual(sharedRecipe);
    expect(backup.chatMessages).not.toContainEqual(sharedChat);
    expect(backup.cookState).not.toContainEqual(sharedCook);

    const photos = backup.photos as Array<Record<string, unknown>>;
    expect(photos.map((photo) => photo.id)).toEqual([
      ownedRecipePhotoId,
      ownedChatPhotoId,
      orphanChatPhotoId,
    ]);
    expect(photos.map((photo) => Object.keys(photo).sort())).toEqual([
      ['base64', 'createdAt', 'id', 'type'],
      ['base64', 'createdAt', 'id', 'type'],
      ['base64', 'createdAt', 'id', 'type'],
    ]);
    expect(Object.keys(backup).sort()).toEqual([
      'app',
      'chatMessages',
      'collections',
      'cookState',
      'exportedAt',
      'exportedBySub',
      'photos',
      'recipes',
      'version',
    ]);
  });
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

  it('re-importing a cloned legacy backup overwrites the clone instead of duplicating it', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');

    await importLibrary(backupFile(), 'alice-sub');
    const first = listRecipes()[0]!;
    const pushedIds = () =>
      lastPushedOps().map((op) =>
        'id' in op.payload ? op.payload.id : op.payload.recipeId,
      );
    const firstPushed = pushedIds();
    await importLibrary(backupFile(), 'alice-sub');

    expect(listRecipes()).toHaveLength(1);
    expect(listRecipes()[0]!.id).toBe(first.id);
    expect(first.id).not.toBe(RECIPE.id);
    expect(listCollections()).toHaveLength(1);
    expect(listAllChat()).toHaveLength(1);
    expect(listAllCook()).toHaveLength(1);
    expect(pushedIds()).toEqual(firstPushed);
  });

  it('re-importing a foreign backup overwrites the clone instead of duplicating it', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');

    await importLibrary(backupFile('alice-sub'), 'carol-sub');
    await importLibrary(backupFile('alice-sub'), 'carol-sub');

    expect(listRecipes()).toHaveLength(1);
    expect(listRecipes()[0]!.id).not.toBe(RECIPE.id);
    expect(listCollections()).toHaveLength(1);
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
