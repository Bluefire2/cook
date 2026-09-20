import type { Collection } from './types';

export type CollectionDestination =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'save'; collectionId: string | undefined };

/** null means an explicit unfiled choice; undefined means no choice yet. */
export function resolveCollectionDestination(
  collections: readonly Collection[] | undefined,
  requestedId: string | undefined,
  selectedId?: string | null,
): CollectionDestination {
  if (collections === undefined) return { kind: 'loading' };
  if (selectedId === null) return { kind: 'save', collectionId: undefined };
  const id = selectedId ?? requestedId;
  return id && collections.some((collection) => collection.id === id)
    ? { kind: 'save', collectionId: id }
    : { kind: 'choose' };
}
