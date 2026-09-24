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
