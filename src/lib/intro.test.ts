import { describe, expect, it } from 'vitest';
import { shouldAskAboutIntro } from './intro';

const ready = {
  sessionStatus: 'signedIn' as const,
  sync: { status: 'idle' as const, lastSyncedAt: 1 },
  hasOwnRecipe: false,
  sheetClosed: true,
};

describe('shouldAskAboutIntro', () => {
  it('asks for a pulled, signed-in library with no recipe of the member’s own', () => {
    expect(shouldAskAboutIntro(ready)).toBe(true);
  });

  it('does not ask when the member has a recipe of their own, or while loading', () => {
    expect(shouldAskAboutIntro({ ...ready, hasOwnRecipe: true })).toBe(false);
    expect(shouldAskAboutIntro({ ...ready, hasOwnRecipe: undefined })).toBe(false);
  });

  it('does not ask before a successful pull, or after a failed one', () => {
    expect(shouldAskAboutIntro({ ...ready, sync: { status: 'idle', lastSyncedAt: null } })).toBe(false);
    expect(shouldAskAboutIntro({ ...ready, sync: { status: 'loading', lastSyncedAt: 1 } })).toBe(false);
    expect(shouldAskAboutIntro({ ...ready, sync: { status: 'error', lastSyncedAt: 1 } })).toBe(false);
  });

  it('does not ask unless signed in', () => {
    for (const sessionStatus of ['loading', 'signedOut', 'offline'] as const) {
      expect(shouldAskAboutIntro({ ...ready, sessionStatus })).toBe(false);
    }
  });

  it('waits while another sheet is open', () => {
    expect(shouldAskAboutIntro({ ...ready, sheetClosed: false })).toBe(false);
  });
});
