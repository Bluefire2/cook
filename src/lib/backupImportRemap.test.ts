import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  getRecipe,
  mergeSharedFromPull,
  replaceFromPull,
} from './libraryMemory';
import {
  remapBackupImport,
  shouldCloneBackupIds,
  type BackupImportEntities,
} from './backupImportRemap';
import type { ChatMessage, Collection, Recipe } from './types';
import type { CookStateRow } from './useCookState';

const ALICE = 'alice-sub';
const CAROL = 'carol-sub';
afterEach(() => {
  clearLibrary();
});

const ALICE_RECIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE_COLLECTION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE_PHOTO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ALICE_CHAT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function seqUuid(): () => string {
  let n = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function entities(overrides: Partial<BackupImportEntities> = {}): BackupImportEntities {
  const recipe: Recipe = {
    id: ALICE_RECIPE,
    title: 'Soup',
    servings: 2,
    ingredientSections: [{ items: [{ item: 'water' }] }],
    steps: [{ text: 'Boil' }],
    tags: [],
    photoId: ALICE_PHOTO,
    galleryPhotoIds: [ALICE_PHOTO],
    createdAt: 1,
    updatedAt: 2,
  };
  const collection: Collection = {
    id: ALICE_COLLECTION,
    name: 'Mine',
    recipeIds: [ALICE_RECIPE],
    createdAt: 1,
    updatedAt: 2,
  };
  const chat: ChatMessage = {
    id: ALICE_CHAT,
    recipeId: ALICE_RECIPE,
    role: 'user',
    content: 'hi',
    photoIds: [ALICE_PHOTO],
    createdAt: 3,
  };
  const cook: CookStateRow = {
    recipeId: ALICE_RECIPE,
    servings: 2,
    currentStep: 0,
    checkedKeys: ['0:0'],
    recipeUpdatedAt: 2,
  };
  return {
    recipes: [recipe],
    collections: [collection],
    chatMessages: [chat],
    cookState: [cook],
    backupPhotoIds: [ALICE_PHOTO],
    ...overrides,
  };
}

describe('shouldCloneBackupIds', () => {
  it('preserves only when exportedBySub matches current sub', () => {
    expect(shouldCloneBackupIds(ALICE, ALICE)).toBe(false);
    expect(shouldCloneBackupIds(ALICE, CAROL)).toBe(true);
    expect(shouldCloneBackupIds(undefined, ALICE)).toBe(true);
  });
});

describe('remapBackupImport', () => {
  it('same-account mode keeps ids and references', () => {
    const input = entities();
    const out = remapBackupImport(input, false, seqUuid());
    expect(out.recipes[0]?.id).toBe(ALICE_RECIPE);
    expect(out.collections[0]?.id).toBe(ALICE_COLLECTION);
    expect(out.collections[0]?.recipeIds).toEqual([ALICE_RECIPE]);
    expect(out.chatMessages[0]?.id).toBe(ALICE_CHAT);
    expect(out.chatMessages[0]?.recipeId).toBe(ALICE_RECIPE);
    expect(out.cookState[0]?.recipeId).toBe(ALICE_RECIPE);
    expect(out.photoIdMap.get(ALICE_PHOTO)).toBe(ALICE_PHOTO);
  });

  it('clone mode remaps every entity and reference', () => {
    const input = entities();
    const nextUuid = seqUuid();
    const out = remapBackupImport(input, true, nextUuid);
    const newRecipe = out.recipes[0]!;
    const newCollection = out.collections[0]!;
    const newChat = out.chatMessages[0]!;
    const newCook = out.cookState[0]!;
    const newPhoto = out.photoIdMap.get(ALICE_PHOTO)!;

    expect(newRecipe.id).not.toBe(ALICE_RECIPE);
    expect(newCollection.id).not.toBe(ALICE_COLLECTION);
    expect(newChat.id).not.toBe(ALICE_CHAT);
    expect(newPhoto).not.toBe(ALICE_PHOTO);

    expect(newCollection.recipeIds).toEqual([newRecipe.id]);
    expect(newRecipe.photoId).toBe(newPhoto);
    expect(newRecipe.galleryPhotoIds).toEqual([newPhoto]);
    expect(newChat.recipeId).toBe(newRecipe.id);
    expect(newChat.photoIds).toEqual([newPhoto]);
    expect(newCook.recipeId).toBe(newRecipe.id);
  });

  it('legacy missing provenance clones (via shouldCloneBackupIds + remap)', () => {
    expect(shouldCloneBackupIds(undefined, CAROL)).toBe(true);
    const out = remapBackupImport(entities(), true, seqUuid());
    expect(out.recipes[0]?.id).not.toBe(ALICE_RECIPE);
  });

  it('keeps chat/cook recipe ids when the recipe row is absent from backup', () => {
    const orphanRecipe = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const input = entities({
      recipes: [],
      collections: [],
      cookState: [
        {
          recipeId: orphanRecipe,
          servings: 1,
          currentStep: 0,
          checkedKeys: [],
          recipeUpdatedAt: 0,
        },
      ],
      chatMessages: [
        {
          id: ALICE_CHAT,
          recipeId: orphanRecipe,
          role: 'assistant',
          content: 'orphan',
          createdAt: 1,
        },
      ],
      backupPhotoIds: [],
    });
    const out = remapBackupImport(input, true, seqUuid());
    expect(out.chatMessages[0]?.recipeId).toBe(orphanRecipe);
    expect(out.cookState[0]?.recipeId).toBe(orphanRecipe);
  });

  it('import-then-share: cloned ids do not block Alice shared originals', () => {
    const nextUuid = seqUuid();
    const cloned = remapBackupImport(entities(), true, nextUuid);
    const carolRecipeId = cloned.recipes[0]!.id;

    replaceFromPull({
      recipes: new Map([[carolRecipeId, cloned.recipes[0]!]]),
      collections: new Map([[cloned.collections[0]!.id, cloned.collections[0]!]]),
      chat: new Map(),
      cook: new Map(),
      remotePhotoIds: new Set(),
    });

    mergeSharedFromPull({
      recipes: new Map([
        [
          ALICE_RECIPE,
          {
            ...cloned.recipes[0]!,
            id: ALICE_RECIPE,
            title: 'Alice original',
          },
        ],
      ]),
      collections: new Map([
        [
          ALICE_COLLECTION,
          {
            id: ALICE_COLLECTION,
            name: 'Alice shared',
            recipeIds: [ALICE_RECIPE],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      ]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [ALICE_RECIPE, { kind: 'shared', ownerSub: ALICE }],
      ]),
      collectionOrigins: new Map([
        [ALICE_COLLECTION, { kind: 'shared', ownerSub: ALICE }],
      ]),
    });

    expect(getRecipe(carolRecipeId)?.title).toBe('Soup');
    expect(getRecipe(ALICE_RECIPE)?.title).toBe('Alice original');
  });

  it('share-then-import: shared canonical rows stay when clone uses fresh ids', () => {
    const sharedRecipe: Recipe = {
      id: ALICE_RECIPE,
      title: 'Alice shared',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    mergeSharedFromPull({
      recipes: new Map([[ALICE_RECIPE, sharedRecipe]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [ALICE_RECIPE, { kind: 'shared', ownerSub: ALICE }],
      ]),
      collectionOrigins: new Map(),
    });

    const cloned = remapBackupImport(entities(), true, seqUuid());
    expect(cloned.recipes[0]?.id).not.toBe(ALICE_RECIPE);
    expect(getRecipe(ALICE_RECIPE)?.title).toBe('Alice shared');
  });
});
