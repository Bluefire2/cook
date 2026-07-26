const PASSWORD_KEY = 'cook.appPassword';

export const settings = {
  getPassword(): string {
    return localStorage.getItem(PASSWORD_KEY) ?? '';
  },
  setPassword(value: string): void {
    localStorage.setItem(PASSWORD_KEY, value);
  },
};
