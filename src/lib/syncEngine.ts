import { useCallback, useEffect, useState } from 'react';
import { compactRecipe } from './recipeStore';
import { OWNER_UID_KEY } from './cacheOwner';
import { db } from './db';
import { enqueue, type OutboxRow } from './outbox';
import { invalidateSession } from './session';
import type { ChatMessage, Recipe } from './types';
import type { CookStateRow } from './useCookState';

export type SyncOutcome = 'ok' | 'error' | 'offline' | 'signedOut' | 'skipped';

export interface SyncResult {
  outcome: SyncOutcome;
  /** Outbox ops the server reported applied:true. photo.put is never included. */
  pushed: number;
  /** Rows written into Dexie from server data that differ from what was stored. */
  applied: number;
}

export type SyncFinishedListener = (result: SyncResult) => void;

export interface SyncToastSpec {
  kind: 'success' | 'error';
  message: string;
}

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
const finishedListeners = new Set<SyncFinishedListener>();

let snapshot: SyncStatusSnapshot = {
  status: 'idle',
  lastSyncedAt: null,
  pendingCount: 0,
};

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error(err);
    }
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

/** Pure. Key-order-insensitive deep compare. Never call on a row holding a Blob. */
export function recordsEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!recordsEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
  for (const key of keys) {
    const valA = key in objA ? objA[key] : undefined;
    const valB = key in objB ? objB[key] : undefined;
    if (valA === undefined && valB === undefined) {
      continue;
    }
    if (!recordsEqual(valA, valB)) {
      return false;
    }
  }
  return true;
}

/** Pure. Maps drain + pull results to the one result for the run. */
export function resolveSyncResult(
  drain: { outcome: 'ok' | 'stop' | 'signedOut'; pushed: number; applied: number },
  pull: { outcome: 'ok' | 'error' | 'signedOut'; applied: number } | null,
): SyncResult {
  const pushed = drain.pushed;
  const applied = drain.applied + (pull?.applied ?? 0);
  if (drain.outcome === 'signedOut') {
    return { outcome: 'signedOut', pushed, applied };
  }
  if (pull === null) {
    return { outcome: 'error', pushed, applied };
  }
  if (pull.outcome === 'signedOut') {
    return { outcome: 'signedOut', pushed, applied };
  }
  if (pull.outcome === 'error' || drain.outcome === 'stop') {
    return { outcome: 'error', pushed, applied };
  }
  return { outcome: 'ok', pushed, applied };
}

/** Pure. The single source of truth for "should we toast, and with what". */
export function decideSyncToast(result: SyncResult): SyncToastSpec | null {
  if (result.outcome === 'error') {
    return { kind: 'error', message: "Couldn't sync" };
  }
  if (
    result.outcome === 'offline' ||
    result.outcome === 'signedOut' ||
    result.outcome === 'skipped'
  ) {
    return null;
  }
  if (result.pushed + result.applied > 0) {
    return { kind: 'success', message: 'Synced' };
  }
  return null;
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
  if (typeof parsedSub !== 'string' || parsedSub === '') {
    return;
  }
  await wipeForAccountSwitch(parsedSub);
  try {
    await runSyncInner(parsedSub);
  } catch (err) {
    console.error(err);
    let pendingCount = snapshot.pendingCount;
    try {
      pendingCount = await db.outbox.count();
    } catch (countErr) {
      console.error(countErr);
    }
    setSnapshot({ status: 'error', pendingCount });
  }
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

async function applyPullPage(changes: PullResponse['changes']): Promise<number> {
  let applied = 0;
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
          const cookRow = await db.cookState.get(id);
          const photoRows = await db.photos.bulkGet([...photoIds]);
          const hadPhoto = photoRows.some((row) => row !== undefined);
          if (existing || messages.length > 0 || cookRow !== undefined || hadPhoto) {
            applied++;
          }
          await db.recipes.delete(id);
          await db.chatMessages.where('recipeId').equals(id).delete();
          await db.cookState.delete(id);
          await db.photos.bulkDelete([...photoIds]);
        } else {
          const existing = await db.recipes.get(id);
          if (!existing || !recordsEqual(existing, normalized)) {
            applied++;
          }
          await db.recipes.put(normalized);
        }
      }

      for (const raw of changes.chatMessages) {
        const id = raw.id as string;
        const normalized = normalizeChatChange(raw);
        if (normalized === 'tombstone') {
          const existing = await db.chatMessages.get(id);
          if (existing !== undefined) {
            applied++;
          }
          await db.chatMessages.delete(id);
        } else {
          const existing = await db.chatMessages.get(id);
          if (!existing || !recordsEqual(existing, normalized)) {
            applied++;
          }
          await db.chatMessages.put(normalized);
        }
      }

      for (const raw of changes.cookState) {
        const recipeId = (raw.recipeId ?? raw.id) as string;
        const normalized = normalizeCookStateChange(raw);
        if (normalized === 'tombstone') {
          const existing = await db.cookState.get(recipeId);
          if (existing !== undefined) {
            applied++;
          }
          await db.cookState.delete(recipeId);
        } else {
          const existing = await db.cookState.get(recipeId);
          if (!existing || !recordsEqual(existing, normalized)) {
            applied++;
          }
          await db.cookState.put(normalized);
        }
      }

      for (const raw of changes.photos) {
        const id = raw.id as string;
        if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
          const existing = await db.photos.get(id);
          if (existing !== undefined) {
            applied++;
          }
          await db.photos.delete(id);
          remoteSet.delete(id);
        } else {
          remoteSet.add(id);
        }
      }

      await writeSyncMeta(REMOTE_PHOTOS_KEY, [...remoteSet]);
    },
  );
  return applied;
}

async function applyServerCurrent(kind: string, current: Record<string, unknown>): Promise<boolean> {
  if (kind === 'recipe.put') {
    const normalized = compactRecipe(current as unknown as Recipe);
    const existing = await db.recipes.get(normalized.id);
    await db.recipes.put(normalized);
    return !existing || !recordsEqual(existing, normalized);
  }
  if (kind === 'chat.put') {
    const normalized = normalizeChatChange(current);
    if (normalized === 'tombstone') {
      return false;
    }
    const existing = await db.chatMessages.get(normalized.id);
    await db.chatMessages.put(normalized);
    return !existing || !recordsEqual(existing, normalized);
  }
  if (kind === 'cookState.put') {
    const normalized = normalizeCookStateChange(current);
    if (normalized === 'tombstone') {
      return false;
    }
    const existing = await db.cookState.get(normalized.recipeId);
    await db.cookState.put(normalized);
    return !existing || !recordsEqual(existing, normalized);
  }
  return false;
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

async function drainOutbox(): Promise<{
  outcome: 'ok' | 'stop' | 'signedOut';
  pushed: number;
  applied: number;
}> {
  let pushed = 0;
  let applied = 0;
  while (true) {
    const rows = await db.outbox.orderBy('seq').toArray();
    if (rows.length === 0) {
      return { outcome: 'ok', pushed, applied };
    }
    const { pushRows } = splitDrainBatch(rows);
    if (pushRows.length === 0) {
      return { outcome: 'ok', pushed, applied };
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
      return { outcome: 'stop', pushed, applied };
    }

    if (response.status === 401) {
      invalidateSession();
      return { outcome: 'signedOut', pushed, applied };
    }

    if (!response.ok) {
      for (const row of batch) {
        if (row.seq !== undefined) {
          await db.outbox.update(row.seq, { attempts: row.attempts + 1 });
        }
      }
      return { outcome: 'stop', pushed, applied };
    }

    const body = (await response.json()) as PushResponse;
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const result = body.results[i];
      if (!result) {
        continue;
      }
      if (shouldDropOutboxResult(result)) {
        if (result.applied) {
          pushed++;
        }
        if (row.seq !== undefined) {
          await db.outbox.delete(row.seq);
        }
        continue;
      }
      if (result.current) {
        if (await applyServerCurrent(row.kind, result.current)) {
          applied++;
        }
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
        return { outcome: 'stop', pushed, applied };
      }
      return { outcome: 'stop', pushed, applied };
    }

    if (batch.length < MAX_DRAIN_OPS) {
      return { outcome: 'ok', pushed, applied };
    }
  }
}

async function pullAll(): Promise<{
  outcome: 'ok' | 'error' | 'signedOut';
  applied: number;
}> {
  let applied = 0;
  try {
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
        return { outcome: 'signedOut', applied };
      }
      if (!response.ok) {
        console.error(`pull failed: ${response.status}`);
        return { outcome: 'error', applied };
      }
      const page = (await response.json()) as PullResponse;
      applied += await applyPullPage(page.changes);
      cursor = mergePullCursor(cursor, page.cursor ?? {});
      await writeSyncMeta(CURSOR_KEY, cursor);
      const cursorAfter = JSON.stringify(cursor);
      if (page.hasMore && cursorAfter === cursorBefore) {
        console.error('pull cursor did not advance');
        return { outcome: 'error', applied };
      }
      if (!page.hasMore) {
        break;
      }
    }
    await writeSyncMeta(LAST_SYNCED_KEY, Date.now());
    return { outcome: 'ok', applied };
  } catch (err) {
    console.error(err);
    return { outcome: 'error', applied };
  }
}

async function runSyncInner(sub: string): Promise<SyncResult> {
  await enqueueUnsyncedLibraryIfNeeded();
  const pendingCount = await db.outbox.count();
  setSnapshot({ pendingCount, status: 'syncing' });

  if (!navigator.onLine) {
    setSnapshot({ status: 'offline', pendingCount });
    return { outcome: 'offline', pushed: 0, applied: 0 };
  }

  const drain = await drainOutbox();
  if (drain.outcome === 'signedOut') {
    setSnapshot({ status: 'signedOut', pendingCount: await db.outbox.count() });
    return resolveSyncResult(drain, null);
  }

  const pull = await pullAll();

  if (pull.outcome === 'signedOut') {
    return resolveSyncResult(drain, pull);
  }

  const lastSyncedAt = (await readSyncMeta(LAST_SYNCED_KEY)) as number | null;
  const ok = drain.outcome !== 'stop' && pull.outcome === 'ok';
  setSnapshot({
    status: ok ? 'idle' : 'error',
    pendingCount: await db.outbox.count(),
    lastSyncedAt: typeof lastSyncedAt === 'number' ? lastSyncedAt : null,
  });
  void sub;
  return resolveSyncResult(drain, pull);
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

async function runOnce(): Promise<SyncResult> {
  let result: SyncResult = { outcome: 'skipped', pushed: 0, applied: 0 };
  try {
    const sessionRaw = localStorage.getItem('cook.session');
    if (!sessionRaw) {
      setSnapshot({ status: 'signedOut' });
      return { outcome: 'signedOut', pushed: 0, applied: 0 };
    }
    let sub: string;
    try {
      sub = (JSON.parse(sessionRaw) as { sub: string }).sub;
    } catch {
      setSnapshot({ status: 'signedOut' });
      return { outcome: 'signedOut', pushed: 0, applied: 0 };
    }
    if (typeof sub !== 'string' || sub === '') {
      setSnapshot({ status: 'signedOut' });
      return { outcome: 'signedOut', pushed: 0, applied: 0 };
    }

    const ownerUid = localStorage.getItem(OWNER_UID_KEY);
    const rowCount = await userRowCount();
    const decision = syncOwnershipDecision(ownerUid, sub, rowCount);

    if (decision === 'needsMigration') {
      setSnapshot({ status: 'needsMigration', pendingCount: await db.outbox.count() });
      return result;
    }

    if (decision === 'wipe-and-pull') {
      await wipeForAccountSwitch(sub);
    } else if (decision === 'claim-and-pull') {
      localStorage.setItem(OWNER_UID_KEY, sub);
    }

    await withLock(async () => {
      result = await runSyncInner(sub);
    });
    return result;
  } catch (err) {
    console.error(err);
    let pendingCount = snapshot.pendingCount;
    try {
      pendingCount = await db.outbox.count();
    } catch (countErr) {
      console.error(countErr);
    }
    setSnapshot({ status: 'error', pendingCount });
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
