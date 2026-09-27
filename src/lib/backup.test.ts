import { afterEach, describe, expect, it, vi } from 'vitest';
import { importLibrary } from './backup';
import {
  clearLibrary,
  listCollections,
  listCookLogs,
  listRecipes,
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

const PHOTO_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const COOK_LOG = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  recipeId: RECIPE.id,
  cookedOn: '2026-09-20',
  rating: 4,
  lessons: 'Less salt.',
  photoIds: [PHOTO_ID],
  createdAt: 3,
  updatedAt: 4,
};

function backupFile(body: Record<string, unknown>): File {
  return new File([JSON.stringify(body)], 'cook-backup.json', {
    type: 'application/json',
  });
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

    await expect(importLibrary(file)).rejects.toThrow("Couldn't import the backup.");
    expect(listRecipes()).toEqual([]);
    expect(listCollections()).toEqual([]);
  });

  it('imports v4 cook logs after the recipes and uploads their photos under the entry recipe', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    vi.mocked(postPhoto).mockResolvedValue('ok');
    const file = backupFile({
      app: 'cook',
      version: 4,
      exportedAt: 5,
      recipes: [RECIPE],
      chatMessages: [],
      cookLogs: [
        { ...COOK_LOG, stray: 'dropped' },
        { ...COOK_LOG, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', cookedOn: '2026-02-30' },
      ],
      photos: [
        { id: PHOTO_ID, type: 'image/jpeg', base64: btoa('jpeg'), createdAt: 6 },
      ],
    });

    await expect(importLibrary(file)).resolves.toEqual({ imported: 1, skipped: 0 });

    expect(postPhoto).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postPhoto).mock.calls[0]?.slice(0, 2)).toEqual([PHOTO_ID, RECIPE.id]);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] as PushOp[];
    expect(ops.map((op) => op.kind)).toEqual(['recipe.put', 'cookLog.put']);
    expect(ops[1]).toEqual({ kind: 'cookLog.put', payload: COOK_LOG });
    expect(listCookLogs(RECIPE.id)).toEqual([COOK_LOG]);
  });

  it('still imports a v3 file without cook logs', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    const file = backupFile({
      app: 'cook',
      version: 3,
      exportedAt: 3,
      recipes: [RECIPE],
      chatMessages: [],
      photos: [],
      collections: [COLLECTION],
    });

    await expect(importLibrary(file)).resolves.toEqual({ imported: 1, skipped: 0 });

    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] as PushOp[];
    expect(ops.map((op) => op.kind)).toEqual(['recipe.put', 'collection.put']);
    expect(listRecipes()).toHaveLength(1);
    expect(listCookLogs()).toEqual([]);
  });
});
