import { useCallback, useEffect, useState } from 'react';
import {
  applyPullChanges,
  mergePullCursor,
  pullPage,
  type PullCursor,
} from './remote';
import {
  clearLibrary,
  markLoaded,
  replaceFromPull,
} from './libraryMemory';
import type { ChatMessage, Recipe } from './types';
import type { CookStateRow } from './useCookState';

export type SyncOutcome = 'ok' | 'error' | 'offline' | 'signedOut' | 'skipped';

export interface SyncResult {
  outcome: SyncOutcome;
  pushed: number;
  applied: number;
}

export type SyncFinishedListener = (result: SyncResult) => void;

export interface SyncToastSpec {
  kind: 'success' | 'error';
  message: string;
}

export type SyncStatusKind = 'idle' | 'loading' | 'error' | 'signedOut';

export type SyncStatusSnapshot = {
  status: SyncStatusKind;
  lastSyncedAt: number | null;
};

const VISIBILITY_DEBOUNCE_MS = 30_000;

let lastVisibilitySync = 0;
let inFlight: Promise<void> | null = null;

let snapshot: SyncStatusSnapshot = {
  status: 'idle',
  lastSyncedAt: null,
};
const listeners = new Set<() => void>();
const finishedListeners = new Set<SyncFinishedListener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function emitSyncFinished(result: SyncResult): void {
  for (const listener of finishedListeners) {
    try {
      listener(result);
    } catch (err) {
      console.error(err);
    }
  }
}

export function onSyncFinished(listener: SyncFinishedListener): () => void {
  finishedListeners.add(listener);
  return () => {
    finishedListeners.delete(listener);
  };
}

function setSnapshot(partial: Partial<SyncStatusSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  emit();
}

/** Pure. The single source of truth for "should we toast, and with what". */
export function decideSyncToast(result: SyncResult): SyncToastSpec | null {
  if (result.outcome === 'error') {
    return { kind: 'error', message: "Couldn't refresh" };
  }
  if (
    result.outcome === 'offline' ||
    result.outcome === 'signedOut' ||
    result.outcome === 'skipped'
  ) {
    return null;
  }
  if (result.applied > 0) {
    return { kind: 'success', message: 'Updated' };
  }
  return null;
}

async function pullAll(): Promise<SyncResult> {
  const acc = {
    recipes: new Map<string, Recipe>(),
    chat: new Map<string, ChatMessage>(),
    cook: new Map<string, CookStateRow>(),
    remotePhotoIds: new Set<string>(),
  };
  let cursor: PullCursor = {};
  let pages = 0;
  while (true) {
    const page = await pullPage(pages === 0 ? null : cursor);
    if (page === 'signedOut') {
      return { outcome: 'signedOut', pushed: 0, applied: 0 };
    }
    if (page === 'error') {
      return { outcome: 'error', pushed: 0, applied: 0 };
    }
    applyPullChanges(acc, page.changes);
    cursor = mergePullCursor(cursor, page.cursor);
    pages += 1;
    if (!page.hasMore) {
      break;
    }
  }
  replaceFromPull(acc);
  return { outcome: 'ok', pushed: 0, applied: 0 };
}

async function runOnce(): Promise<SyncResult> {
  const sessionRaw = localStorage.getItem('cook.session');
  if (!sessionRaw) {
    clearLibrary();
    setSnapshot({ status: 'signedOut' });
    return { outcome: 'signedOut', pushed: 0, applied: 0 };
  }
  setSnapshot({ status: 'loading' });
  try {
    const result = await pullAll();
    if (result.outcome === 'signedOut') {
      setSnapshot({ status: 'signedOut' });
      return result;
    }
    if (result.outcome === 'error') {
      markLoaded();
      setSnapshot({ status: 'error' });
      return result;
    }
    setSnapshot({ status: 'idle', lastSyncedAt: Date.now() });
    return result;
  } catch (err) {
    console.error(err);
    markLoaded();
    setSnapshot({ status: 'error' });
    return { outcome: 'error', pushed: 0, applied: 0 };
  }
}

export function sync(): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  const run = (async () => {
    const result = await runOnce();
    emitSyncFinished(result);
  })();
  inFlight = run;
  const clear = () => {
    if (inFlight === run) {
      inFlight = null;
    }
  };
  void run.then(clear, clear);
  return run;
}

export function triggerSyncAfterSession(_sub: string): void {
  void sync();
}

export function setupSyncTriggers(): void {
  window.addEventListener('online', () => {
    void sync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    const now = Date.now();
    if (now - lastVisibilitySync < VISIBILITY_DEBOUNCE_MS) {
      return;
    }
    lastVisibilitySync = now;
    void sync();
  });
}

export function notifyImportComplete(): void {
  void sync();
}

export async function resyncFromServer(): Promise<void> {
  await sync();
}

export function useSyncStatus(): SyncStatusSnapshot {
  const [, tick] = useState(0);
  const refresh = useCallback(() => {
    tick((n) => n + 1);
  }, []);

  useEffect(() => {
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh]);

  return snapshot;
}
