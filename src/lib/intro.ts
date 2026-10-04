import type { SessionStatus } from './session';
import type { SyncStatusSnapshot } from './syncEngine';

/**
 * Whether Library should ask the server if this member has seen the
 * new-member intro (`docs/plans/new-member-intro.md`, D1): signed in, the
 * library has been pulled without an error, the member has no live recipe of
 * their own (shared rows don't count), and no other sheet is open. Existing
 * members have recipes, so they never cause a request.
 */
export function shouldAskAboutIntro(input: {
  sessionStatus: SessionStatus;
  sync: SyncStatusSnapshot;
  hasOwnRecipe: boolean | undefined;
  sheetClosed: boolean;
}): boolean {
  return (
    input.sessionStatus === 'signedIn' &&
    input.sync.status === 'idle' &&
    input.sync.lastSyncedAt !== null &&
    input.hasOwnRecipe === false &&
    input.sheetClosed
  );
}
