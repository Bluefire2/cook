import { beginLocalWrite, endLocalWrite, localWritesOpen } from './libraryMemory';
import {
  localWriteOverlapsPull,
  pullAfterLocalWrite,
  type SyncOutcome,
} from './syncEngine';

/**
 * How long writes must stay quiet before a discarded pull is reread.
 * Cooking taps that land close together share one follow-up pull instead of
 * starting a full owned-plus-shared read per tap.
 */
const DEFAULT_REREAD_QUIET_MS = 300;

let rereadQuietMs = DEFAULT_REREAD_QUIET_MS;

type RereadChoice = 'if-overlap' | 'always' | 'no';

export type LocalWriteResult<T> = {
  value: T;
  /**
   * True when the push landed. A reread may then replace the library.
   * False keeps `preserve` available so a failed optimistic row can be put
   * back after that read publishes.
   */
  reconcile: boolean;
  /**
   * `if-overlap` (default) rereads when a pull overlapped, including one that
   * already finished superseded. `always` rereads even then. `no` does not.
   */
  reread?: RereadChoice;
  /** Rethrown after the follow-up read is scheduled. */
  error?: unknown;
  /**
   * Re-applies an optimistic row after a reread publishes. Skipped when
   * `stillCurrent` is false: a later write replaced that same row.
   */
  preserve?: () => void;
  /**
   * Sampled immediately before the follow-up pull. False when a later write
   * replaced this row, so `preserve` must not paint it back over that write.
   */
  stillCurrent?: () => boolean;
};

type Waiter = {
  epoch: number;
  preserve?: () => void;
  stillCurrent?: () => boolean;
  resolve: (outcome: SyncOutcome) => void;
};

let rereadTimer: ReturnType<typeof setTimeout> | null = null;
let rereadWaiters: Waiter[] = [];
let rereadChain: Promise<void> = Promise.resolve();

/** Test isolation. Production quiet time is 300ms. */
export function setRereadQuietForTests(ms: number): void {
  rereadQuietMs = ms;
}

export function resetRereadScheduleForTests(): void {
  if (rereadTimer !== null) {
    clearTimeout(rereadTimer);
    rereadTimer = null;
  }
  const pending = rereadWaiters;
  rereadWaiters = [];
  for (const waiter of pending) {
    waiter.resolve('skipped');
  }
  rereadQuietMs = DEFAULT_REREAD_QUIET_MS;
}

function shouldReread(epoch: number, outcome: LocalWriteResult<unknown>): boolean {
  const choice = outcome.reread ?? 'if-overlap';
  if (choice === 'no') {
    return false;
  }
  if (choice === 'always') {
    return true;
  }
  return localWriteOverlapsPull(epoch);
}

function queueFlush(): void {
  rereadChain = rereadChain.then(() => flushReread());
}

/** Puts the batch back. A later flush samples `stillCurrent` again. */
function deferReread(batch: Waiter[]): void {
  rereadWaiters = batch.concat(rereadWaiters);
  if (rereadTimer !== null) {
    return;
  }
  const delay = rereadQuietMs > 0 ? rereadQuietMs : 0;
  rereadTimer = setTimeout(() => {
    rereadTimer = null;
    queueFlush();
  }, delay);
}

async function flushReread(): Promise<void> {
  const batch = rereadWaiters;
  rereadWaiters = [];
  if (batch.length === 0) {
    return;
  }
  if (localWritesOpen() > 0) {
    // The open write schedules its own read when it finishes. Resolving now
    // would drop a reread that write might decline (`reread: 'no'`).
    deferReread(batch);
    return;
  }
  const epoch = batch[batch.length - 1].epoch;
  // Sample before the pull. The pull replaces row objects, so a check after
  // it publishes cannot tell a later write from the server snapshot.
  const keep = batch.map(
    (waiter) => waiter.preserve !== undefined && (waiter.stillCurrent?.() ?? true),
  );
  let outcome: SyncOutcome = 'error';
  try {
    outcome = await pullAfterLocalWrite(epoch);
  } catch {
    outcome = 'error';
  }
  if (outcome === 'superseded') {
    // The pull did not publish. Keep every callback for the read that does.
    deferReread(batch);
    return;
  }
  if (outcome === 'ok' || outcome === 'error') {
    for (let i = 0; i < batch.length; i += 1) {
      if (keep[i]) {
        batch[i].preserve?.();
      }
    }
  }
  for (const waiter of batch) {
    waiter.resolve(outcome);
  }
}

function kickReread(immediate: boolean): void {
  if (!immediate && rereadQuietMs > 0) {
    if (rereadTimer !== null) {
      clearTimeout(rereadTimer);
    }
    rereadTimer = setTimeout(() => {
      rereadTimer = null;
      queueFlush();
    }, rereadQuietMs);
    return;
  }
  if (rereadTimer !== null) {
    clearTimeout(rereadTimer);
    rereadTimer = null;
  }
  queueFlush();
}

function scheduleReread(
  epoch: number,
  preserve: (() => void) | undefined,
  stillCurrent: (() => boolean) | undefined,
  immediate: boolean,
): Promise<SyncOutcome> {
  return new Promise((resolve) => {
    rereadWaiters.push({ epoch, preserve, stillCurrent, resolve });
    kickReread(immediate);
  });
}

export type LocalWriteOptions = {
  /** Wait until the follow-up pull finishes. Leave and delete need the outcome. */
  awaitReread?: boolean;
  onReread?: (outcome: SyncOutcome) => void;
};

/**
 * Holds the library against an in-flight pull for one optimistic write.
 *
 * `body` mutates the library, then pushes. A pull that already started (the
 * sign-in pull, most often) captured an older epoch and must not publish.
 * When that pull overlapped — including one that already finished superseded —
 * the server is read again so the discarded snapshot is not the last word.
 * A failed push still schedules that read, then `preserve` puts its optimistic
 * row back unless a later write replaced that same row. Quiet writes share
 * one read. The read is not awaited, so Save and the first Ask message are
 * not held for it.
 *
 * `error` is rethrown after the read is scheduled, which is before it
 * publishes. A throw from `body` does not schedule a read.
 *
 * A new caller names the row it touched and whether a failure keeps that row
 * or rolls it back. Sign-out writes nothing back, a later write on that same
 * row wins, and quiet writes share this one follow-up pull. Those three stay
 * here. Do not add another `reread` or `preserve` switch for a one-row write.
 * Delete, discard, leave, backup import, and photo-set membership are the
 * exceptions already: a full snapshot, not one row, decides their outcome.
 * A write that fits neither is the point to drop this follow-up read, not to
 * grow the flags.
 */
export async function withLocalWrite<T>(
  body: (ctx: { epoch: number }) => Promise<LocalWriteResult<T>>,
  options?: LocalWriteOptions,
): Promise<T> {
  const epoch = beginLocalWrite();
  let outcome: LocalWriteResult<T> | undefined;
  let thrown: unknown;
  try {
    outcome = await body({ epoch });
  } catch (err) {
    thrown = err;
  } finally {
    endLocalWrite();
  }
  if (outcome && shouldReread(epoch, outcome)) {
    const preserve = outcome.reconcile ? undefined : outcome.preserve;
    const stillCurrent = outcome.reconcile ? undefined : outcome.stillCurrent;
    const pending = scheduleReread(
      epoch,
      preserve,
      stillCurrent,
      options?.awaitReread === true,
    );
    if (options?.awaitReread) {
      const pull = await pending;
      options.onReread?.(pull);
    }
  }
  if (thrown) {
    throw thrown;
  }
  if (outcome === undefined) {
    throw new Error('local write produced no result');
  }
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return outcome.value;
}
