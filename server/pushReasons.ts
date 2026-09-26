// Keep this module dependency-free and browser-safe: src/lib/pushReasons.ts
// re-exports it into the Vite client bundle as well as the Node sync path.
/** Per-op push reject reasons shared by the Node sync path and the client. */
export type PushRejectReason =
  | 'invalid'
  | 'unknown'
  | 'cap'
  | 'stale'
  | 'already-deleted'
  | 'recipe-deleted';

/** Writes the server discarded — callers must roll back instead of treating them as LWW. */
export type DiscardedPushReason = Extract<
  PushRejectReason,
  'invalid' | 'unknown' | 'cap'
>;

export const DISCARDED_PUSH_REASONS: ReadonlySet<DiscardedPushReason> = new Set([
  'invalid',
  'unknown',
  'cap',
]);

export function isDiscardedPushReason(
  reason: string,
): reason is DiscardedPushReason {
  return DISCARDED_PUSH_REASONS.has(reason as DiscardedPushReason);
}

/**
 * Internal field stored beside viewer chat and cook rows only. The value is
 * the shared recipe owner's Google `sub`, discovered from incoming shares.
 * Client payloads cannot set or clear it. Absent means the parent write was
 * authorized by a live owned recipe (or the row predates this marker). It is
 * not part of `ChatMessage`, `CookStateRow`, or a version-3 backup entity.
 */
export const SHARED_PARENT_OWNER_SUB_FIELD = 'sharedParentOwnerSub';
