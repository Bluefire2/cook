import { beforeEach, describe, expect, it } from 'vitest';
import { settings, THEME_KEY } from './settings';

const store = new Map<string, string>();

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

describe('theme settings', () => {
  it("getTheme() is 'dark' when the key is missing", () => {
    expect(settings.getTheme()).toBe('dark');
  });

  it("getTheme() is 'dark' when the stored value is invalid", () => {
    localStorage.setItem(THEME_KEY, 'system');
    expect(settings.getTheme()).toBe('dark');
  });

  it("setTheme('light') then getTheme() is 'light'", () => {
    settings.setTheme('light');
    expect(settings.getTheme()).toBe('light');
  });

  it("setTheme('dark') then getTheme() is 'dark'", () => {
    settings.setTheme('dark');
    expect(settings.getTheme()).toBe('dark');
  });
});
