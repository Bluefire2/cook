import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatStore } from './chatStore';
import { collectionStore } from './collectionStore';
import { cookLogStore } from './cookLogStore';
import {
  clearLibrary,
  getCook,
  getCookLog,
  getRecipe,
  listChat,
  listCollections,
  localWritesOpen,
  replaceFromPull,
} from './libraryMemory';
import { pushOps, type PullChanges, type PullPage, type SharedPullPage } from './remote';
import { recipeStore } from './recipeStore';
import { pullAll } from './syncEngine';
import type { Recipe } from './types';
import { updateCookState, type CookStateRow } from './useCookState';

vi.mock('./remote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remote')>();
  return {
    ...actual,
    pushOps: vi.fn(async () => 'ok' as const),
    postPhoto: vi.fn(async () => 'ok' as const),
  };
});

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function recipe(title = 'Soup'): Recipe {
  return {
    id: RECIPE_ID,
    title,
    servings: 2,
    ingredientSections: [{ items: [{ item: 'onion' }] }],
    steps: [{ text: 'Chop.' }, { text: 'Cook.' }],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function cook(currentStep: number): CookStateRow {
  return {
    recipeId: RECIPE_ID,
    servings: 2,
    currentStep,
    checkedKeys: [],
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
    cookLogs: [],
    ...overrides,
  };
}

function ownedPage(changes: PullChanges): PullPage {
  return { changes, cursor: {}, hasMore: false };
}

function sharedPage(): SharedPullPage {
  return {
    changes: { recipes: [], collections: [], photos: [] },
    cursorToken: '',
    hasMore: false,
  };
}

function seed(base: Recipe = recipe(), row: CookStateRow = cook(0)): void {
  replaceFromPull({
    recipes: new Map([[base.id, base]]),
    collections: new Map(),
    chat: new Map(),
    cook: new Map([[row.recipeId, row]]),
    cookLogs: new Map(),
    remotePhotoIds: new Set(),
  });
}

/** A pull that has captured its epoch and is waiting on the first page. */
function startPull(page: PullPage): {
  pending: Promise<Awaited<ReturnType<typeof pullAll>>>;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<PullPage>((resolve) => {
    release = () => resolve(page);
  });
  const pending = pullAll({
    pullPage: () => gate,
    pullSharedPage: async () => sharedPage(),
  });
  return { pending, release };
}

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
  vi.mocked(pushOps).mockResolvedValue('ok');
});

describe('optimistic writes vs an in-flight pull', () => {
  it('keeps both cook taps when the app-open pull started first', async () => {
    const base = recipe();
    seed(base, cook(0));
    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));

    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    flight.release();

    const result = await flight.pending;
    expect(result.outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a checkbox tap made while the pull is in flight', async () => {
    const base = recipe();
    seed(base, cook(0));
    const flight = startPull(
      ownedPage(ownedChanges({ cookState: [pullDoc({ ...cook(0), checkedKeys: [] })] })),
    );

    await updateCookState(base, (prev) => ({ ...prev, checkedKeys: ['0-0'] }));
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.checkedKeys).toEqual(['0-0']);
  });

  it('does not publish a pull that starts while the cook push is still open', async () => {
    const base = recipe();
    seed(base, cook(0));
    let releasePush: (result: 'ok') => void = () => {};
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePush = resolve;
        }),
    );

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => {
      expect(pushOps).toHaveBeenCalled();
    });
    expect(localWritesOpen()).toBe(1);

    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));
    releasePush('ok');
    await writing;
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a failed cook tap when the overlapping pull would revert it', async () => {
    const base = recipe();
    seed(base, cook(0));
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));

    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
  });

  it('applies a pull that starts after the cook write settles', async () => {
    const base = recipe();
    seed(base, cook(0));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));

    const result = await pullAll({
      pullPage: async () =>
        ownedPage(
          ownedChanges({
            recipes: [pullDoc(recipe())],
            cookState: [pullDoc(cook(0))],
          }),
        ),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(0);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a chat message appended during the pull', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges()));

    const message = await chatStore.append({
      recipeId: RECIPE_ID,
      role: 'user',
      content: 'more salt?',
    });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(listChat(RECIPE_ID).map((row) => row.id)).toEqual([message.id]);
  });

  it('applies a pull that starts after the chat write settles', async () => {
    seed();
    await chatStore.append({
      recipeId: RECIPE_ID,
      role: 'user',
      content: 'more salt?',
    });

    const result = await pullAll({
      pullPage: async () =>
        ownedPage(
          ownedChanges({
            chatMessages: [
              {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                recipeId: RECIPE_ID,
                role: 'user',
                content: 'from the server',
                createdAt: 9,
              },
            ],
          }),
        ),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(listChat(RECIPE_ID).map((row) => row.content)).toEqual(['from the server']);
  });

  it('keeps a recipe save made during the pull', async () => {
    const base = recipe('Soup');
    seed(base);
    const flight = startPull(ownedPage(ownedChanges({ recipes: [pullDoc(recipe('Soup'))] })));

    await recipeStore.save({ ...base, title: 'Stew' });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getRecipe(RECIPE_ID)?.title).toBe('Stew');
  });

  it('applies a pull that starts after the recipe save settles', async () => {
    const base = recipe('Soup');
    seed(base);
    await recipeStore.save({ ...base, title: 'Stew' });

    const result = await pullAll({
      pullPage: async () => ownedPage(ownedChanges({ recipes: [pullDoc(recipe('Broth'))] })),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(getRecipe(RECIPE_ID)?.title).toBe('Broth');
  });

  it('keeps a collection created during the pull', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges()));

    const created = await collectionStore.create('Dinners');
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(listCollections().map((row) => row.id)).toEqual([created.id]);
  });

  it('applies a pull that starts after the collection create settles', async () => {
    seed();
    await collectionStore.create('Dinners');

    const result = await pullAll({
      pullPage: async () => ownedPage(ownedChanges()),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(listCollections()).toEqual([]);
  });

  it('keeps a cook log created during the pull', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges({ recipes: [pullDoc(recipe())] })));

    const log = await cookLogStore.create({
      recipeId: RECIPE_ID,
      cookedOn: '2026-09-20',
      lessons: 'Less salt.',
    });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCookLog(log.id)?.lessons).toBe('Less salt.');
  });

  it('applies a pull that starts after the cook log create settles', async () => {
    seed();
    const log = await cookLogStore.create({
      recipeId: RECIPE_ID,
      cookedOn: '2026-09-20',
      lessons: 'Less salt.',
    });

    const result = await pullAll({
      pullPage: async () => ownedPage(ownedChanges({ recipes: [pullDoc(recipe())] })),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(getCookLog(log.id)).toBeUndefined();
  });
});
