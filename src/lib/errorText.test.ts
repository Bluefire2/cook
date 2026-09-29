import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverError, serverErrorText } from './errorText';
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
  it('maps stt-bad-language to catalog text', () => {
    settings.setLocale('uk');
    expect(
      serverErrorText(
        { code: 'stt-bad-language', error: 'That language is not supported.' },
        'error.dictationFailed',
      ),
    ).toBe('Ця мова не підтримується.');
  });

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
    })).toBe('There are already 20 unused invite links. Revoke one to mint another.');
    expect(
      serverErrorText({ code: 'invite-cap', error: 'invite-cap', max: 3 }, 'error.requestFailed', {
        status: 409,
      }),
    ).toBe('There are already 3 unused invite links. Revoke one to mint another.');
  });

  it('uses the member cap sentence that does not mention revoke', () => {
    settings.setLocale('en');
    expect(
      serverErrorText(
        { code: 'member-invite-cap', error: 'cap' },
        'error.requestFailed',
        { status: 409 },
      ),
    ).toBe('There are already too many unused invite links. Try again later.');
  });

  it('fills {max} for the member invite limit', () => {
    settings.setLocale('en');
    expect(
      serverErrorText(
        { code: 'member-invite-limit', error: 'limit', max: 5 },
        'error.requestFailed',
        { status: 409 },
      ),
    ).toBe('You have already invited 5 people.');
  });

  it('keeps the quota code on the thrown error', () => {
    settings.setLocale('en');
    const err = serverError(
      { code: 'member-invite-limit', error: 'limit', max: 5 },
      'error.requestFailed',
      { status: 409 },
    );
    expect(err).toMatchObject({
      message: 'You have already invited 5 people.',
      code: 'member-invite-limit',
    });
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

  it('maps translate failures to catalog text', () => {
    settings.setLocale('uk');
    expect(
      serverErrorText(
        { code: 'translate-failed', error: "Couldn't translate this recipe." },
        'error.requestFailed',
      ),
    ).toBe('Не вдалося перекласти цей рецепт.');
    settings.setLocale('zh-Hans');
    expect(
      serverErrorText(
        { code: 'translate-rate-limited', error: 'Too many translations. Try again later.' },
        'error.requestFailed',
      ),
    ).toBe('翻译太频繁了，请你稍后再试。');
  });

  it('uses the generic catalog fallback when code and error are absent', () => {
    settings.setLocale('en');
    expect(serverErrorText(null, 'error.sharingUpdate')).toBe("Couldn't update sharing.");
    expect(serverErrorText({ code: 'nope' }, 'error.importFailedStatus', { status: 502 })).toBe(
      'Import failed (502).',
    );
  });
});
