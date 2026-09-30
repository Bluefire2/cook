import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { chatStore } from './chatStore';
import { addPendingBlob, clearLibrary, getSnapshot, listChat, upsertChat } from './libraryMemory';
import { postPhoto, pushOps } from './remote';
import type { ChatMessage } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const earlier: ChatMessage = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  recipeId: RECIPE_ID,
  role: 'user',
  content: 'Can I use leeks?',
  createdAt: 1,
};

/** `remote` clears the library before it reports a 401. */
async function signOut(): Promise<'signedOut'> {
  clearLibrary();
  return 'signedOut';
}

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
  vi.mocked(postPhoto).mockReset();
});

describe('chatStore after sign-out', () => {
  it('append does not restore the thread when the put signs out', async () => {
    upsertChat(earlier);
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(
      chatStore.append({ recipeId: RECIPE_ID, role: 'user', content: 'And shallots?' }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(listChat(RECIPE_ID)).toEqual([]);
  });

  it('append does not restore the thread when a photo upload signs out', async () => {
    upsertChat(earlier);
    addPendingBlob(PHOTO_ID, new Blob(['x'], { type: 'image/jpeg' }));
    vi.mocked(postPhoto).mockImplementation(signOut);

    await expect(
      chatStore.append({
        recipeId: RECIPE_ID,
        role: 'user',
        content: 'Is this done?',
        photoIds: [PHOTO_ID],
      }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(pushOps).not.toHaveBeenCalled();
    expect(listChat(RECIPE_ID)).toEqual([]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('append still restores the thread when the put fails for another reason', async () => {
    upsertChat(earlier);
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(
      chatStore.append({ recipeId: RECIPE_ID, role: 'user', content: 'And shallots?' }),
    ).rejects.toThrow(t('error.messageSave'));

    expect(listChat(RECIPE_ID)).toEqual([earlier]);
  });

  it('clearForRecipe does not restore the thread when the clear signs out', async () => {
    upsertChat(earlier);
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(chatStore.clearForRecipe(RECIPE_ID)).rejects.toThrow(t('error.sessionExpired'));

    expect(listChat(RECIPE_ID)).toEqual([]);
  });

  it('clearForRecipe still restores the thread when the clear fails for another reason', async () => {
    upsertChat(earlier);
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(chatStore.clearForRecipe(RECIPE_ID)).rejects.toThrow(t('error.chatClear'));

    expect(listChat(RECIPE_ID)).toEqual([earlier]);
  });
});
