import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverErrorText } from './errorText';
import { settings } from './settings';

const store = new Map<string, string>();
const originalStorage = globalThis.localStorage;

beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

afterEach(() => {
  store.clear();
  if (originalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    globalThis.localStorage = originalStorage;
  }
});

describe('serverErrorText', () => {
  it('maps a known code to catalog text', () => {
    settings.setLocale('uk');
    expect(
      serverErrorText(
        { code: 'share-self', error: 'Cannot share with yourself' },
        'error.sharingUpdate',
      ),
    ).toBe('Ви не можете поділитися із собою.');
  });

  it('fills {max} from the body for a full collection', () => {
    settings.setLocale('en');
    expect(
      serverErrorText(
        { code: 'share-full', error: 'This collection already has 20 people', max: 7 },
        'error.sharingUpdate',
      ),
    ).toBe('This collection already has 7 people.');
  });

  it('uses 20 for invite-cap only when max is absent', () => {
    settings.setLocale('en');
    expect(serverErrorText({ code: 'invite-cap', error: 'invite-cap' }, 'error.requestFailed', {
      status: 409,
    })).toBe('You already have 20 unused invite links. Revoke one to mint another.');
    expect(
      serverErrorText({ code: 'invite-cap', error: 'invite-cap', max: 3 }, 'error.requestFailed', {
        status: 409,
      }),
    ).toBe('You already have 3 unused invite links. Revoke one to mint another.');
  });

  it('falls back to the English error when the code is unknown', () => {
    settings.setLocale('uk');
    expect(
      serverErrorText(
        { code: 'not-a-real-code', error: 'Cannot share with yourself' },
        'error.sharingUpdate',
      ),
    ).toBe('Cannot share with yourself');
  });

  it('falls back to the English error when a required placeholder is missing', () => {
    settings.setLocale('uk');
    expect(
      serverErrorText(
        { code: 'share-full', error: 'This collection already has 20 people' },
        'error.sharingUpdate',
      ),
    ).toBe('This collection already has 20 people');
  });

  it('uses the generic catalog fallback when code and error are absent', () => {
    settings.setLocale('en');
    expect(serverErrorText(null, 'error.sharingUpdate')).toBe("Couldn't update sharing.");
    expect(serverErrorText({ code: 'nope' }, 'error.importFailedStatus', { status: 502 })).toBe(
      'Import failed (502).',
    );
  });
});
