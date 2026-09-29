const STORAGE_KEY = 'cook.librarySearch';

export function readPersistedLibrarySearch(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Non-empty values are persisted for library remounts; empty clears storage. */
export function writePersistedLibrarySearch(query: string): void {
  try {
    if (query === '') {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, query);
  } catch {
    // ignore quota / private mode
  }
}
