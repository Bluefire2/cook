const PASSWORD_KEY = 'cook.appPassword';

export const THEME_KEY = 'cook.theme';

export type Theme = 'dark' | 'light';

export const settings = {
  getPassword(): string {
    return localStorage.getItem(PASSWORD_KEY) ?? '';
  },
  setPassword(value: string): void {
    localStorage.setItem(PASSWORD_KEY, value);
  },
  getTheme(): Theme {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  },
  setTheme(value: Theme): void {
    localStorage.setItem(THEME_KEY, value);
  },
};
