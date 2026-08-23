import type { Theme } from './settings';

export const PAGE_COLORS = { dark: '#1c1917', light: '#faf7f2' } as const;

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.backgroundColor = PAGE_COLORS[theme];

  let themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (!themeColorMeta) {
    themeColorMeta = document.createElement('meta');
    themeColorMeta.setAttribute('name', 'theme-color');
    document.head.appendChild(themeColorMeta);
  }
  themeColorMeta.setAttribute('content', PAGE_COLORS[theme]);

  let statusBarMeta = document.querySelector(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  );
  if (!statusBarMeta) {
    statusBarMeta = document.createElement('meta');
    statusBarMeta.setAttribute('name', 'apple-mobile-web-app-status-bar-style');
    document.head.appendChild(statusBarMeta);
  }
  statusBarMeta.setAttribute('content', theme === 'dark' ? 'black' : 'default');
}
