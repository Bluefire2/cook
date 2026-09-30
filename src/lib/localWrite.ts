import {
  beginLocalWrite,
  endLocalWrite,
  libraryEpoch,
  localWritesOpen,
} from './libraryMemory';
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
  /** Re-applies an optimistic row after a reread publishes, if no later write began. */
  preserve?: () => void;
};

type Waiter = {
  epoch: number;
  preserve?: () => void;
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

async function flushReread(): Promise<void> {
  const batch = rereadWaiters;
  rereadWaiters = [];
  if (batch.length === 0) {
    return;
  }
  if (localWritesOpen() > 0) {
    // The open write schedules its own read when it finishes. Resolving now
    // would drop a reread that write might decline (`reread: 'no'`).
    rereadWaiters = batch.concat(rereadWaiters);
    if (rereadTimer === null) {
      const delay = rereadQuietMs > 0 ? rereadQuietMs : 0;
      rereadTimer = setTimeout(() => {
        rereadTimer = null;
        queueFlush();
      }, delay);
    }
    return;
  }
  const epoch = batch[batch.length - 1].epoch;
  let outcome: SyncOutcome = 'error';
  try {
    outcome = await pullAfterLocalWrite(epoch);
  } catch {
    outcome = 'error';
  }
  if (outcome === 'ok' || outcome === 'error') {
    for (const waiter of batch) {
      if (waiter.preserve && libraryEpoch() === waiter.epoch) {
        waiter.preserve();
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
  immediate: boolean,
): Promise<SyncOutcome> {
  return new Promise((resolve) => {
    rereadWaiters.push({ epoch, preserve, resolve });
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
 * row back if nothing newer has started. Quiet writes share one read. The
 * read is not awaited, so Save and the first Ask message are not held for it.
 *
 * `error` is rethrown after the read is scheduled, which is before it
 * publishes. A throw from `body` does not schedule a read.
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
    const pending = scheduleReread(epoch, preserve, options?.awaitReread === true);
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
