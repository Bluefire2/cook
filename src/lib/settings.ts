export const THEME_KEY = 'cook.theme';

export type Theme = 'dark' | 'light';

export const settings = {
  getTheme(): Theme {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  },
  setTheme(value: Theme): void {
    localStorage.setItem(THEME_KEY, value);
  },
};
