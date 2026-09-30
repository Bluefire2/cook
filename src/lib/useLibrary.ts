import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe, type LibrarySnapshot } from './libraryMemory';

/**
 * One field of the library snapshot. A write that leaves this field's map
 * alone keeps its identity, so the caller does not re-render for it.
 */
export function useLibrarySlice<K extends keyof LibrarySnapshot>(key: K): LibrarySnapshot[K] {
  return useSyncExternalStore(subscribe, () => getSnapshot()[key]);
}

/**
 * A value selected from the library snapshot. `select` must return an
 * existing reference or a primitive, never a fresh array or object.
 */
export function useLibrarySelect<T>(select: (snapshot: LibrarySnapshot) => T): T {
  return useSyncExternalStore(subscribe, () => select(getSnapshot()));
}
