const STORAGE_KEY = 'cook.librarySearch';

export type LibraryView = { query: string; browseAll: boolean };

const EMPTY: LibraryView = { query: '', browseAll: false };

/** Search text and scope, kept for this tab so Library remounts restore them. */
export function readPersistedLibraryView(): LibraryView {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY;
    }
    const parsed = JSON.parse(raw) as Partial<LibraryView>;
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      browseAll: parsed.browseAll === true,
    };
  } catch {
    return EMPTY;
  }
}

/** A view with no search text and no widened scope clears the key. */
export function writePersistedLibraryView(view: LibraryView): void {
  try {
    if (view.query === '' && !view.browseAll) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // ignore quota / private mode
  }
}

export function clearPersistedLibraryView(): void {
  writePersistedLibraryView(EMPTY);
}
