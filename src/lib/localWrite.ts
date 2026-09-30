import { beginLocalWrite, endLocalWrite } from './libraryMemory';
import { localWriteOverlapsPull, pullAfterLocalWrite } from './syncEngine';

/**
 * Holds the library against an in-flight pull for one optimistic write.
 *
 * `body` mutates the library, then pushes. A pull that already started (the
 * sign-in pull, most often) captured an older epoch and must not publish:
 * its snapshot does not contain this write. When `body` returns
 * `reconcile: true` and such a pull overlapped — including one that already
 * finished and was discarded — the server is read again so that snapshot is
 * not the last word. That read is not awaited: the optimistic row is already
 * published and the push has settled, so Save and the first Ask message are
 * not held for the app-open pull plus a reread.
 *
 * `reconcile: false`, or a throw, leaves the library as `body` left it. A
 * failed push can keep its optimistic row, or a rollback, without a follow-up
 * read painting the server's older copy back on top.
 */
export async function withLocalWrite<T>(
  body: () => Promise<{ value: T; reconcile: boolean }>,
): Promise<T> {
  const epoch = beginLocalWrite();
  let reconcile = false;
  try {
    const outcome = await body();
    reconcile = outcome.reconcile;
    return outcome.value;
  } finally {
    endLocalWrite();
    if (reconcile && localWriteOverlapsPull(epoch)) {
      void pullAfterLocalWrite(epoch).catch(() => {
        // The next pull reconciles.
      });
    }
  }
}
