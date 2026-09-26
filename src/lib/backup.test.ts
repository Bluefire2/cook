import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportLibrary, importLibrary } from './backup';
import {
  addPendingBlob,
  clearLibrary,
  getPendingBlob,
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

function allPushedOps(): PushOp[] {
  return vi.mocked(pushOps).mock.calls.flatMap((call) => call[0] ?? []);
}

type ImportEvent =
  | { type: 'push-start'; phase: 'recipes' | 'dependents'; ops: PushOp[] }
  | { type: 'push-end'; phase: 'recipes' | 'dependents'; ops: PushOp[] }
  | { type: 'photo-start'; id: string; recipeId: string }
  | { type: 'photo-end'; id: string; recipeId: string };

/** Records start and completion so tests can see that a phase finished before the next one starts. */
function recordImportCalls(onRecipePushStart?: () => void): ImportEvent[] {
  const events: ImportEvent[] = [];
  vi.mocked(pushOps).mockImplementation(async (ops) => {
    const phase: 'recipes' | 'dependents' =
      ops.length > 0 && ops.every((op) => op.kind === 'recipe.put')
        ? 'recipes'
        : 'dependents';
    const snapshot = [...ops];
    if (phase === 'recipes') {
      onRecipePushStart?.();
    }
    events.push({ type: 'push-start', phase, ops: snapshot });
    await Promise.resolve();
    events.push({ type: 'push-end', phase, ops: snapshot });
    return 'ok';
  });
  vi.mocked(postPhoto).mockImplementation(async (id, recipeId) => {
    events.push({ type: 'photo-start', id, recipeId });
    await Promise.resolve();
    events.push({ type: 'photo-end', id, recipeId });
    return 'ok';
  });
  return events;
}

function eventLabels(events: ImportEvent[]): string[] {
  return events.map((event) => {
    if (event.type === 'photo-start' || event.type === 'photo-end') {
      return event.type;
    }
    return `${event.type}:${event.phase}`;
  });
}

const ONE_PHOTO_ORDER = [
  'push-start:recipes',
  'push-end:recipes',
  'photo-start',
  'photo-end',
  'push-start:dependents',
  'push-end:dependents',
];

function phaseOps(events: ImportEvent[], phase: 'recipes' | 'dependents'): PushOp[] {
  const end = [...events]
    .reverse()
    .find((event) => event.type === 'push-end' && event.phase === phase);
  if (end?.type !== 'push-end') {
    throw new Error(`missing ${phase} push`);
  }
  return end.ops;
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

    const recipePut = allPushedOps().find((op) => op.kind === 'recipe.put');
    expect(recipePut?.payload.id).not.toBe(RECIPE.id);
    expect(getSnapshot().recipes.get(RECIPE.id)?.title).toBe('Carol soup');
    expect(listRecipes()).toHaveLength(2);
  });

  it('explicit foreign-provenance clone completes remapped recipe.put before the first postPhoto', async () => {
    const events = recordImportCalls();
    replaceFromPull({
      recipes: new Map([[RECIPE.id, { ...RECIPE, title: 'Carol soup' }]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });

    await importLibrary(backupFile('alice-sub'), 'carol-sub');

    expect(eventLabels(events)).toEqual(ONE_PHOTO_ORDER);
    const recipePut = phaseOps(events, 'recipes')[0];
    const photo = events.find((event) => event.type === 'photo-end');
    expect(recipePut?.kind).toBe('recipe.put');
    if (recipePut?.kind !== 'recipe.put' || photo?.type !== 'photo-end') {
      throw new Error('expected a remapped recipe put and photo upload');
    }
    expect(recipePut.payload.id).not.toBe(RECIPE.id);
    expect(recipePut.payload.photoId).not.toBe(PHOTO);
    expect(photo).toEqual({
      type: 'photo-end',
      id: recipePut.payload.photoId,
      recipeId: recipePut.payload.id,
    });
    expect(getSnapshot().recipes.get(RECIPE.id)?.title).toBe('Carol soup');
  });

  it('provenance-less clone into an empty account completes recipe.put before postPhoto', async () => {
    const events = recordImportCalls();

    await importLibrary(backupFile(), 'alice-sub');

    expect(eventLabels(events)).toEqual(ONE_PHOTO_ORDER);
    const recipePut = phaseOps(events, 'recipes')[0];
    const photo = events.find((event) => event.type === 'photo-end');
    expect(recipePut?.kind).toBe('recipe.put');
    if (recipePut?.kind !== 'recipe.put' || photo?.type !== 'photo-end') {
      throw new Error('expected a remapped recipe put and photo upload');
    }
    expect(recipePut.payload.id).not.toBe(RECIPE.id);
    expect(photo.id).toBe(recipePut.payload.photoId);
    expect(photo.recipeId).toBe(recipePut.payload.id);
    expect(photo.id).not.toBe(PHOTO);
  });

  it('after successful uploads, collections, chat, cook, and attachments use the remapped graph', async () => {
    const events = recordImportCalls();

    await importLibrary(backupFile('alice-sub'), 'carol-sub');

    expect(eventLabels(events)).toEqual(ONE_PHOTO_ORDER);
    const recipePut = phaseOps(events, 'recipes')[0];
    const photo = events.find((event) => event.type === 'photo-end');
    expect(recipePut?.kind).toBe('recipe.put');
    if (recipePut?.kind !== 'recipe.put' || photo?.type !== 'photo-end') {
      throw new Error('expected a remapped recipe put and photo upload');
    }
    const dependent = phaseOps(events, 'dependents');
    expect(dependent.map((op) => op.kind)).toEqual([
      'collection.put',
      'chat.put',
      'cookState.put',
    ]);
    const collectionPut = dependent[0];
    const chatPut = dependent[1];
    const cookPut = dependent[2];
    if (
      collectionPut?.kind !== 'collection.put'
      || chatPut?.kind !== 'chat.put'
      || cookPut?.kind !== 'cookState.put'
    ) {
      throw new Error('expected remapped dependent puts');
    }
    expect(collectionPut.payload.id).not.toBe(COLLECTION.id);
    expect(collectionPut.payload.recipeIds).toEqual([recipePut.payload.id]);
    expect(chatPut.payload.id).not.toBe(CHAT.id);
    expect(chatPut.payload.recipeId).toBe(recipePut.payload.id);
    expect(chatPut.payload.photoIds).toEqual([photo.id]);
    expect(cookPut.payload.recipeId).toBe(recipePut.payload.id);
    expect(photo).toEqual({
      type: 'photo-end',
      id: recipePut.payload.photoId,
      recipeId: recipePut.payload.id,
    });
  });

  it.each(['error', 'signedOut'] as const)(
    'a parent recipe %s performs zero photo uploads and zero dependent pushes',
    async (result) => {
      vi.mocked(pushOps).mockResolvedValue(result);
      vi.mocked(postPhoto).mockResolvedValue('ok');

      await expect(importLibrary(backupFile('alice-sub'), 'carol-sub')).rejects.toThrow(
        result === 'signedOut'
          ? 'Please sign in again — your session expired.'
          : "Couldn't import the backup.",
      );

      expect(postPhoto).not.toHaveBeenCalled();
      expect(pushOps).toHaveBeenCalledTimes(1);
      const ops = vi.mocked(pushOps).mock.calls[0]?.[0] ?? [];
      expect(ops.length).toBeGreaterThan(0);
      expect(ops.every((op) => op.kind === 'recipe.put')).toBe(true);
      expect(listRecipes()).toEqual([]);
      expect(listCollections()).toEqual([]);
      expect(listAllChat()).toEqual([]);
      expect(listAllCook()).toEqual([]);
    },
  );

  it('rolls back locally when a photo upload fails after the recipe push', async () => {
    // Remote import stays best-effort across requests. The recipe put already
    // returned ok, and this failure does not delete that server row; the next
    // refresh would reveal it. Only the optimistic local snapshot is restored.
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('error');

    await expect(importLibrary(backupFile('alice-sub'), 'carol-sub')).rejects.toThrow(
      "Couldn't upload a photo from the backup.",
    );

    expect(listRecipes()).toEqual([]);
    expect(listCollections()).toEqual([]);
    expect(pushOps).toHaveBeenCalledTimes(1);
    expect(postPhoto).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] ?? [];
    expect(ops.every((op) => op.kind === 'recipe.put')).toBe(true);
  });

  it('same-account preserve mode remains overwrite-by-id and idempotent', async () => {
    const events = recordImportCalls();
    replaceFromPull({
      recipes: new Map([[RECIPE.id, { ...RECIPE, title: 'Older soup', photoId: PHOTO }]]),
      collections: new Map([[COLLECTION.id, COLLECTION]]),
      chat: new Map([[CHAT.id, CHAT]]),
      cook: new Map([[COOK.recipeId, COOK]]),
      remotePhotoIds: new Set([PHOTO]),
    });

    await importLibrary(backupFile('alice-sub'), 'alice-sub');
    await importLibrary(backupFile('alice-sub'), 'alice-sub');

    expect(eventLabels(events)).toEqual([...ONE_PHOTO_ORDER, ...ONE_PHOTO_ORDER]);
    expect(events.filter((event) => event.type === 'photo-end')).toEqual([
      { type: 'photo-end', id: PHOTO, recipeId: RECIPE.id },
      { type: 'photo-end', id: PHOTO, recipeId: RECIPE.id },
    ]);
    const recipePushes = events.filter(
      (event) => event.type === 'push-end' && event.phase === 'recipes',
    );
    expect(recipePushes).toHaveLength(2);
    for (const push of recipePushes) {
      if (push.type !== 'push-end') {
        throw new Error('expected recipe push');
      }
      expect(push.ops).toEqual([
        expect.objectContaining({
          kind: 'recipe.put',
          payload: expect.objectContaining({ id: RECIPE.id, photoId: PHOTO }),
        }),
      ]);
    }
    expect(listRecipes()).toHaveLength(1);
    expect(listRecipes()[0]).toMatchObject({ id: RECIPE.id, title: 'Soup', photoId: PHOTO });
    expect(listCollections()).toEqual([COLLECTION]);
    expect(listAllChat()).toEqual([CHAT]);
    expect(listAllCook()).toEqual([COOK]);
  });

  it('photo-free imports do not upload and still push parents before dependents', async () => {
    const events = recordImportCalls();
    const chat = { id: CHAT.id, recipeId: RECIPE.id, role: 'user' as const, content: 'How long?', createdAt: 3 };
    const file = new File(
      [
        JSON.stringify({
          app: 'cook',
          version: 3,
          exportedAt: 3,
          recipes: [RECIPE],
          chatMessages: [chat],
          photos: [],
          cookState: [COOK],
          collections: [COLLECTION],
        }),
      ],
      'cook-backup.json',
      { type: 'application/json' },
    );

    await importLibrary(file, 'alice-sub');

    expect(postPhoto).not.toHaveBeenCalled();
    expect(eventLabels(events)).toEqual([
      'push-start:recipes',
      'push-end:recipes',
      'push-start:dependents',
      'push-end:dependents',
    ]);
    const recipePut = phaseOps(events, 'recipes')[0];
    expect(recipePut?.kind).toBe('recipe.put');
    if (recipePut?.kind !== 'recipe.put') {
      throw new Error('expected a recipe put');
    }
    expect(recipePut.payload.id).not.toBe(RECIPE.id);
    const dependent = phaseOps(events, 'dependents');
    const collectionPut = dependent[0];
    const chatPut = dependent[1];
    const cookPut = dependent[2];
    if (
      collectionPut?.kind !== 'collection.put'
      || chatPut?.kind !== 'chat.put'
      || cookPut?.kind !== 'cookState.put'
    ) {
      throw new Error('expected dependent puts');
    }
    expect(collectionPut.payload.recipeIds).toEqual([recipePut.payload.id]);
    expect(chatPut.payload.recipeId).toBe(recipePut.payload.id);
    expect(chatPut.payload.photoIds).toBeUndefined();
    expect(cookPut.payload.recipeId).toBe(recipePut.payload.id);
  });

  it('imports the orphan-chat-photo export without uploading or pushing orphans', async () => {
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

    const exported = await exportLibrary('viewer-sub');
    clearLibrary();
    let danglingBeforeRemoteWrite = false;
    const events = recordImportCalls(() => {
      danglingBeforeRemoteWrite =
        listAllChat().some((message) => message.id === orphanChat.id)
        || listAllCook().some((row) => row.recipeId === 'missing-recipe')
        || getPendingBlob(orphanChatPhotoId) !== undefined;
    });

    await importLibrary(exported, 'viewer-sub');

    expect(danglingBeforeRemoteWrite).toBe(false);
    expect(eventLabels(events)).toEqual([
      'push-start:recipes',
      'push-end:recipes',
      'photo-start',
      'photo-end',
      'photo-start',
      'photo-end',
      'push-start:dependents',
      'push-end:dependents',
    ]);
    expect(events.filter((event) => event.type === 'photo-end')).toEqual([
      { type: 'photo-end', id: ownedRecipePhotoId, recipeId: RECIPE.id },
      { type: 'photo-end', id: ownedChatPhotoId, recipeId: RECIPE.id },
    ]);
    const dependent = phaseOps(events, 'dependents');
    expect(dependent.map((op) => op.kind)).toEqual([
      'collection.put',
      'chat.put',
      'cookState.put',
    ]);
    const chatPut = dependent[1];
    const cookPut = dependent[2];
    expect(chatPut?.kind === 'chat.put' ? chatPut.payload.id : undefined).toBe(ownedChat.id);
    expect(cookPut?.kind === 'cookState.put' ? cookPut.payload.recipeId : undefined).toBe(RECIPE.id);
    expect(listAllChat().map((message) => message.id)).toEqual([ownedChat.id]);
    expect(listAllCook().map((row) => row.recipeId)).toEqual([RECIPE.id]);
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([RECIPE.id]);
    expect(getPendingBlob(orphanChatPhotoId)).toBeUndefined();
  });

  it('decides preserve versus clone on the full graph before dropping dangling dependents', async () => {
    const orphanPhotoId = 'orphan-only-photo';
    replaceFromPull({
      recipes: new Map(),
      collections: new Map(),
      chat: new Map([[CHAT.id, { ...CHAT, content: 'owned chat', photoIds: undefined }]]),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });
    let danglingBeforeRemoteWrite = false;
    const events = recordImportCalls(() => {
      danglingBeforeRemoteWrite =
        listAllChat().some((message) => message.content === 'dangling')
        || listAllCook().some((row) => row.recipeId === 'missing-recipe')
        || getPendingBlob(orphanPhotoId) !== undefined;
    });
    const file = new File(
      [
        JSON.stringify({
          app: 'cook',
          version: 3,
          exportedAt: 3,
          recipes: [{ ...RECIPE, photoId: PHOTO }],
          chatMessages: [
            {
              id: CHAT.id,
              recipeId: 'missing-recipe',
              role: 'user',
              content: 'dangling',
              photoIds: [orphanPhotoId],
              createdAt: 9,
            },
          ],
          photos: [
            { id: orphanPhotoId, type: 'image/jpeg', base64: 'YQ==', createdAt: 4 },
            { id: PHOTO, type: 'image/jpeg', base64: 'YQ==', createdAt: 3 },
          ],
          cookState: [{ ...COOK, recipeId: 'missing-recipe' }],
          collections: [],
        }),
      ],
      'cook-backup.json',
      { type: 'application/json' },
    );

    await importLibrary(file, 'alice-sub');

    expect(danglingBeforeRemoteWrite).toBe(false);
    expect(eventLabels(events)).toEqual(ONE_PHOTO_ORDER);
    const recipePut = phaseOps(events, 'recipes')[0];
    expect(recipePut).toMatchObject({
      kind: 'recipe.put',
      payload: { id: RECIPE.id, photoId: PHOTO },
    });
    expect(events.filter((event) => event.type === 'photo-end')).toEqual([
      { type: 'photo-end', id: PHOTO, recipeId: RECIPE.id },
    ]);
    expect(phaseOps(events, 'dependents')).toEqual([]);
    expect(listAllChat()).toEqual([{ ...CHAT, content: 'owned chat', photoIds: undefined }]);
    expect(listAllCook()).toEqual([]);
    expect(getPendingBlob(orphanPhotoId)).toBeUndefined();
  });
});
