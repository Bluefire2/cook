import { useCallback, useEffect, useState } from 'react';
import { compactRecipe } from './recipeStore';
import { OWNER_UID_KEY } from './cacheOwner';
import { db } from './db';
import { enqueue, type OutboxRow } from './outbox';
import { invalidateSession } from './session';
import type { ChatMessage, Recipe } from './types';
import type { CookStateRow } from './useCookState';

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'signedOut'
  | 'needsMigration';

export interface SyncStatusSnapshot {
  status: SyncStatus;
  lastSyncedAt: number | null;
  pendingCount: number;
}

const CURSOR_KEY = 'cursor';
const REMOTE_PHOTOS_KEY = 'remotePhotos';
const LAST_SYNCED_KEY = 'lastSyncedAt';
const LEASE_KEY = 'lease';

const TAB_OWNER = crypto.randomUUID();
const MAX_DRAIN_OPS = 50;
const MAX_DRAIN_ATTEMPTS = 5;
const VISIBILITY_DEBOUNCE_MS = 30_000;

let inFlight: Promise<void> | null = null;
let lastVisibilitySync = 0;

type SyncListener = () => void;
const listeners = new Set<SyncListener>();

let snapshot: SyncStatusSnapshot = {
  status: 'idle',
  lastSyncedAt: null,
  pendingCount: 0,
};

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setSnapshot(partial: Partial<SyncStatusSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  emit();
}

function encodePullCursor(cursor: PullCursor): string {
  const json = JSON.stringify(cursor);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readSyncMeta(key: string): Promise<unknown> {
  const row = await db.syncMeta.get(key);
  return row?.value;
}

async function writeSyncMeta(key: string, value: unknown): Promise<void> {
  await db.syncMeta.put({ key, value });
}

export function syncOwnershipDecision(
  ownerUid: string | null,
  sub: string,
  rowCount: number,
): 'proceed' | 'wipe-and-pull' | 'claim-and-pull' | 'needsMigration' {
  const absent = ownerUid === null || ownerUid === '';
  if (!absent && ownerUid === sub) {
    return 'proceed';
  }
  if (!absent && ownerUid !== sub) {
    return 'wipe-and-pull';
  }
  if (absent && rowCount === 0) {
    return 'claim-and-pull';
  }
  return 'needsMigration';
}

export function splitDrainBatch(rows: OutboxRow[]): {
  pushRows: OutboxRow[];
  skippedPhotoPutSeqs: number[];
} {
  const pushRows: OutboxRow[] = [];
  const skippedPhotoPutSeqs: number[] = [];
  for (const row of rows) {
    if (row.kind === 'photo.put') {
      if (row.seq !== undefined) {
        skippedPhotoPutSeqs.push(row.seq);
      }
      continue;
    }
    pushRows.push(row);
  }
  return { pushRows, skippedPhotoPutSeqs };
}

export function shouldDropOutboxResult(result: {
  applied: boolean;
  reason?: string;
}): boolean {
  if (result.applied) {
    return true;
  }
  return result.reason === 'invalid' || result.reason === 'unknown';
}

export function mergePullCursor(
  prev: PullCursor,
  next: PullCursor,
): PullCursor {
  return { ...prev, ...next };
}

export function shouldEnqueueUnsyncedLibrary(args: {
  lastSyncedAt: unknown;
  pendingCount: number;
  rowCount: number;
}): boolean {
  if (args.pendingCount > 0) {
    return false;
  }
  if (typeof args.lastSyncedAt === 'number') {
    return false;
  }
  return args.rowCount > 0;
}

type PullCursor = Partial<
  Record<'recipes' | 'chatMessages' | 'cookState' | 'photos', [number, string]>
>;

interface PullResponse {
  user: { sub: string; email: string };
  changes: {
    recipes: Record<string, unknown>[];
    chatMessages: Record<string, unknown>[];
    cookState: Record<string, unknown>[];
    photos: Record<string, unknown>[];
  };
  cursor: PullCursor;
  hasMore: boolean;
}

interface PushResponse {
  results: {
    index: number;
    applied: boolean;
    reason?: string;
    current?: Record<string, unknown>;
  }[];
}

async function userRowCount(): Promise<number> {
  const [recipes, chat, photos, cook] = await Promise.all([
    db.recipes.count(),
    db.chatMessages.count(),
    db.photos.count(),
    db.cookState.count(),
  ]);
  return recipes + chat + photos + cook;
}

async function wipeForAccountSwitch(sub: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.chatMessages, db.photos, db.cookState, db.outbox, db.syncMeta],
    async () => {
      await db.recipes.clear();
      await db.chatMessages.clear();
      await db.photos.clear();
      await db.cookState.clear();
      await db.outbox.clear();
      await db.syncMeta.clear();
    },
  );
  localStorage.setItem(OWNER_UID_KEY, sub);
}

export async function confirmMigration(): Promise<void> {
  const sessionRaw = localStorage.getItem('cook.session');
  if (!sessionRaw) {
    return;
  }
  let parsedSub: string;
  try {
    parsedSub = (JSON.parse(sessionRaw) as { sub: string }).sub;
  } catch {
    return;
  }
  await wipeForAccountSwitch(parsedSub);
  await runSyncInner(parsedSub);
}

function normalizeRecipeChange(raw: Record<string, unknown>): Recipe | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  return compactRecipe(raw as unknown as Recipe);
}

function normalizeChatChange(raw: Record<string, unknown>): ChatMessage | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  const message: ChatMessage = {
    id: raw.id as string,
    recipeId: raw.recipeId as string,
    role: raw.role as 'user' | 'assistant',
    content: raw.content as string,
    createdAt: raw.createdAt as number,
  };
  if (Array.isArray(raw.photoIds)) {
    message.photoIds = raw.photoIds as string[];
  }
  if (raw.proposedRecipe !== undefined) {
    message.proposedRecipe = raw.proposedRecipe as ChatMessage['proposedRecipe'];
  }
  return message;
}

function normalizeCookStateChange(
  raw: Record<string, unknown>,
): CookStateRow | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  return {
    recipeId: raw.recipeId as string,
    servings: raw.servings as number,
    currentStep: raw.currentStep as number,
    checkedKeys: raw.checkedKeys as string[],
    recipeUpdatedAt: raw.recipeUpdatedAt as number,
  };
}

async function applyPullPage(changes: PullResponse['changes']): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.chatMessages, db.photos, db.cookState, db.syncMeta],
    async () => {
      let remotePhotos = (await readSyncMeta(REMOTE_PHOTOS_KEY)) as string[] | undefined;
      if (!Array.isArray(remotePhotos)) {
        remotePhotos = [];
      }
      const remoteSet = new Set(remotePhotos);

      for (const raw of changes.recipes) {
        const id = raw.id as string;
        const normalized = normalizeRecipeChange(raw);
        if (normalized === 'tombstone') {
          const existing = await db.recipes.get(id);
          const messages = await db.chatMessages.where('recipeId').equals(id).toArray();
          const photoIds = new Set<string>();
          if (existing?.photoId) {
            photoIds.add(existing.photoId);
          }
          for (const m of messages) {
            for (const pid of m.photoIds ?? []) {
              photoIds.add(pid);
            }
          }
          await db.recipes.delete(id);
          await db.chatMessages.where('recipeId').equals(id).delete();
          await db.cookState.delete(id);
          await db.photos.bulkDelete([...photoIds]);
        } else {
          await db.recipes.put(normalized);
        }
      }

      for (const raw of changes.chatMessages) {
        const id = raw.id as string;
        const normalized = normalizeChatChange(raw);
        if (normalized === 'tombstone') {
          await db.chatMessages.delete(id);
        } else {
          await db.chatMessages.put(normalized);
        }
      }

      for (const raw of changes.cookState) {
        const recipeId = (raw.recipeId ?? raw.id) as string;
        const normalized = normalizeCookStateChange(raw);
        if (normalized === 'tombstone') {
          await db.cookState.delete(recipeId);
        } else {
          await db.cookState.put(normalized);
        }
      }

      for (const raw of changes.photos) {
        const id = raw.id as string;
        if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
          await db.photos.delete(id);
          remoteSet.delete(id);
        } else {
          remoteSet.add(id);
        }
      }

      await writeSyncMeta(REMOTE_PHOTOS_KEY, [...remoteSet]);
    },
  );
}

async function applyServerCurrent(kind: string, current: Record<string, unknown>): Promise<void> {
  if (kind === 'recipe.put') {
    await db.recipes.put(compactRecipe(current as unknown as Recipe));
    return;
  }
  if (kind === 'chat.put') {
    const normalized = normalizeChatChange(current);
    if (normalized !== 'tombstone') {
      await db.chatMessages.put(normalized);
    }
    return;
  }
  if (kind === 'cookState.put') {
    const normalized = normalizeCookStateChange(current);
    if (normalized !== 'tombstone') {
      await db.cookState.put(normalized);
    }
  }
}

async function enqueueUnsyncedLibraryIfNeeded(): Promise<void> {
  const lastSyncedAt = await readSyncMeta(LAST_SYNCED_KEY);
  const pendingCount = await db.outbox.count();
  const rowCount = await userRowCount();
  if (!shouldEnqueueUnsyncedLibrary({ lastSyncedAt, pendingCount, rowCount })) {
    return;
  }

  await db.transaction(
    'rw',
    [db.recipes, db.chatMessages, db.photos, db.cookState, db.outbox],
    async (tx) => {
      const recipes = await db.recipes.toArray();
      const chatMessages = await db.chatMessages.toArray();
      const cookState = await db.cookState.toArray();
      const photos = await db.photos.toArray();
      const photoById = new Map(photos.map((photo) => [photo.id, photo]));
      const attributed = new Set<string>();

      for (const recipe of recipes) {
        await enqueue(tx, { kind: 'recipe.put', payload: compactRecipe(recipe) });
        if (recipe.photoId !== undefined && !attributed.has(recipe.photoId)) {
          attributed.add(recipe.photoId);
          const photo = photoById.get(recipe.photoId);
          await enqueue(tx, {
            kind: 'photo.put',
            payload: {
              id: recipe.photoId,
              recipeId: recipe.id,
              updatedAt: photo?.createdAt ?? recipe.updatedAt,
            },
          });
        }
      }
      for (const message of chatMessages) {
        for (const photoId of message.photoIds ?? []) {
          if (attributed.has(photoId)) {
            continue;
          }
          attributed.add(photoId);
          const photo = photoById.get(photoId);
          await enqueue(tx, {
            kind: 'photo.put',
            payload: {
              id: photoId,
              recipeId: message.recipeId,
              updatedAt: photo?.createdAt ?? message.createdAt,
            },
          });
        }
        await enqueue(tx, { kind: 'chat.put', payload: message });
      }
      for (const row of cookState) {
        await enqueue(tx, {
          kind: 'cookState.put',
          payload: { ...row, updatedAt: Date.now() },
        });
      }
    },
  );
}

async function drainOutbox(): Promise<'ok' | 'stop' | 'signedOut'> {
  while (true) {
    const rows = await db.outbox.orderBy('seq').toArray();
    if (rows.length === 0) {
      return 'ok';
    }
    const { pushRows } = splitDrainBatch(rows);
    if (pushRows.length === 0) {
      return 'ok';
    }
    const batch = pushRows.slice(0, MAX_DRAIN_OPS);

    const ops = batch.map((row) => ({ kind: row.kind, payload: row.payload }));
    let response: Response;
    try {
      response = await fetch('/api/sync/push', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
    } catch {
      for (const row of batch) {
        if (row.seq !== undefined) {
          await db.outbox.update(row.seq, { attempts: row.attempts + 1 });
        }
      }
      return 'stop';
    }

    if (response.status === 401) {
      invalidateSession();
      return 'signedOut';
    }

    if (!response.ok) {
      for (const row of batch) {
        if (row.seq !== undefined) {
          await db.outbox.update(row.seq, { attempts: row.attempts + 1 });
        }
      }
      return 'stop';
    }

    const body = (await response.json()) as PushResponse;
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const result = body.results[i];
      if (!result) {
        continue;
      }
      if (shouldDropOutboxResult(result)) {
        if (row.seq !== undefined) {
          await db.outbox.delete(row.seq);
        }
        continue;
      }
      if (result.current) {
        await applyServerCurrent(row.kind, result.current);
        if (row.seq !== undefined) {
          await db.outbox.delete(row.seq);
        }
        continue;
      }
      const attempts = row.attempts + 1;
      if (row.seq !== undefined) {
        await db.outbox.update(row.seq, { attempts });
      }
      if (attempts > MAX_DRAIN_ATTEMPTS) {
        return 'stop';
      }
      return 'stop';
    }

    if (batch.length < MAX_DRAIN_OPS) {
      return 'ok';
    }
  }
}

async function pullAll(): Promise<void> {
  let cursor = ((await readSyncMeta(CURSOR_KEY)) as PullCursor | undefined) ?? {};
  while (true) {
    const cursorBefore = JSON.stringify(cursor);
    const params = new URLSearchParams();
    if (Object.keys(cursor).length > 0) {
      params.set('cursor', encodePullCursor(cursor));
    }
    const response = await fetch(`/api/sync/pull?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.status === 401) {
      invalidateSession();
      setSnapshot({ status: 'signedOut' });
      return;
    }
    if (!response.ok) {
      throw new Error(`pull failed: ${response.status}`);
    }
    const page = (await response.json()) as PullResponse;
    await applyPullPage(page.changes);
    cursor = mergePullCursor(cursor, page.cursor ?? {});
    await writeSyncMeta(CURSOR_KEY, cursor);
    const cursorAfter = JSON.stringify(cursor);
    if (page.hasMore && cursorAfter === cursorBefore) {
      throw new Error('pull cursor did not advance');
    }
    if (!page.hasMore) {
      break;
    }
  }
  await writeSyncMeta(LAST_SYNCED_KEY, Date.now());
}

async function runSyncInner(sub: string): Promise<void> {
  await enqueueUnsyncedLibraryIfNeeded();
  const pendingCount = await db.outbox.count();
  setSnapshot({ pendingCount, status: 'syncing' });

  if (!navigator.onLine) {
    setSnapshot({ status: 'offline', pendingCount });
    return;
  }

  const drainResult = await drainOutbox();
  if (drainResult === 'signedOut') {
    setSnapshot({ status: 'signedOut', pendingCount: await db.outbox.count() });
    return;
  }

  try {
    await pullAll();
  } catch {
    setSnapshot({
      status: 'error',
      pendingCount: await db.outbox.count(),
    });
    return;
  }

  const lastSyncedAt = (await readSyncMeta(LAST_SYNCED_KEY)) as number | null;
  setSnapshot({
    status: drainResult === 'stop' ? 'error' : 'idle',
    pendingCount: await db.outbox.count(),
    lastSyncedAt: typeof lastSyncedAt === 'number' ? lastSyncedAt : null,
  });
  void sub;
}

async function withLock(run: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request('sous-sync', { mode: 'exclusive' }, async () => {
      await run();
    });
    return;
  }

  const now = Date.now();
  const acquired = await db.transaction('rw', db.syncMeta, async () => {
    const row = await db.syncMeta.get(LEASE_KEY);
    const lease = row?.value as { owner?: string; until?: number } | undefined;
    if (lease && typeof lease.until === 'number' && lease.until >= now && lease.owner !== TAB_OWNER) {
      return false;
    }
    await db.syncMeta.put({ key: LEASE_KEY, value: { owner: TAB_OWNER, until: now + 15_000 } });
    return true;
  });
  if (!acquired) {
    return;
  }

  const refresh = setInterval(() => {
    void db.syncMeta.put({
      key: LEASE_KEY,
      value: { owner: TAB_OWNER, until: Date.now() + 15_000 },
    });
  }, 5_000);

  try {
    await run();
  } finally {
    clearInterval(refresh);
    await db.syncMeta.delete(LEASE_KEY);
  }
}

export async function sync(): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = (async () => {
    try {
      const sessionRaw = localStorage.getItem('cook.session');
      if (!sessionRaw) {
        setSnapshot({ status: 'signedOut' });
        return;
      }
      let sub: string;
      try {
        sub = (JSON.parse(sessionRaw) as { sub: string }).sub;
      } catch {
        setSnapshot({ status: 'signedOut' });
        return;
      }

      const ownerUid = localStorage.getItem(OWNER_UID_KEY);
      const rowCount = await userRowCount();
      const decision = syncOwnershipDecision(ownerUid, sub, rowCount);

      if (decision === 'needsMigration') {
        setSnapshot({ status: 'needsMigration', pendingCount: await db.outbox.count() });
        return;
      }

      if (decision === 'wipe-and-pull') {
        await wipeForAccountSwitch(sub);
      } else if (decision === 'claim-and-pull') {
        localStorage.setItem(OWNER_UID_KEY, sub);
      }

      await withLock(async () => {
        await runSyncInner(sub);
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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
  await db.syncMeta.delete(CURSOR_KEY);
  await sync();
}

export function useSyncStatus(): SyncStatusSnapshot {
  const [, tick] = useState(0);
  const refresh = useCallback(() => {
    tick((n) => n + 1);
  }, []);

  useEffect(() => {
    listeners.add(refresh);
    void db.outbox.count().then((pendingCount) => {
      setSnapshot({ pendingCount });
    });
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh]);

  return snapshot;
}
