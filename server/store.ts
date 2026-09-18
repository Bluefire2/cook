import { FieldPath, Firestore, type Transaction } from '@google-cloud/firestore';
import { firestoreConfig } from './env.ts';

export type StoreKind = 'recipes' | 'chatMessages' | 'cookState' | 'photos';

export type CursorTuple = [number, string];

export type PullCursor = Partial<Record<StoreKind, CursorTuple>>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

let firestoreClient: Firestore | null = null;

export function getStoreFirestore(): Firestore {
  if (firestoreClient === null) {
    firestoreClient = new Firestore(firestoreConfig());
  }
  return firestoreClient;
}

function getFirestore(): Firestore {
  return getStoreFirestore();
}

function userRef(uid: string) {
  return getFirestore().collection('users').doc(uid);
}

function colRef(uid: string, kind: StoreKind) {
  return userRef(uid).collection(kind);
}

export function gcsDeletesColRef(uid: string) {
  return userRef(uid).collection('gcsDeletes');
}

function gcsDeletesRef(uid: string) {
  return gcsDeletesColRef(uid);
}

export function photoDocRef(uid: string, photoId: string) {
  return colRef(uid, 'photos').doc(photoId);
}

export function recipeDocRef(uid: string, recipeId: string) {
  return colRef(uid, 'recipes').doc(recipeId);
}

export function photosColRef(uid: string) {
  return colRef(uid, 'photos');
}

export function readStoredMutationState(
  data: Record<string, unknown> | undefined,
): StoredMutationState | null {
  return readStoredState(data);
}

export interface StoredMutationState {
  updatedAt: number;
  deletedAt?: number;
}

export type CompareMutationResult =
  | { allow: true; undeleting: boolean }
  | {
      allow: false;
      reason: 'stale' | 'already-deleted';
    };

export function compareMutation(
  stored: StoredMutationState | null,
  clientUpdatedAt: number,
  mutation: 'put' | 'tombstone',
): CompareMutationResult {
  const storedAt = stored?.updatedAt ?? 0;
  const isTombstone =
    stored !== null &&
    stored.deletedAt !== undefined &&
    Number.isFinite(stored.deletedAt);

  if (mutation === 'put') {
    if (isTombstone) {
      if (clientUpdatedAt > storedAt) {
        return { allow: true, undeleting: true };
      }
      return { allow: false, reason: 'already-deleted' };
    }
    if (storedAt > clientUpdatedAt) {
      return { allow: false, reason: 'stale' };
    }
    return { allow: true, undeleting: false };
  }

  if (storedAt > clientUpdatedAt) {
    return { allow: false, reason: 'stale' };
  }
  return { allow: true, undeleting: false };
}

export function encodePullCursor(cursor: PullCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePullCursor(raw: string | null | undefined): PullCursor {
  if (raw === null || raw === undefined || raw === '') {
    return {};
  }
  try {
    const buf = Buffer.from(raw, 'base64url');
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (!isPlainObject(parsed)) {
      return {};
    }
    const out: PullCursor = {};
    const kinds: StoreKind[] = ['recipes', 'chatMessages', 'cookState', 'photos'];
    for (const kind of kinds) {
      const entry = parsed[kind];
      if (!Array.isArray(entry) || entry.length !== 2) {
        continue;
      }
      const ts = finiteNumber(entry[0]);
      const id = entry[1];
      if (ts === undefined || !isUuid(id)) {
        continue;
      }
      out[kind] = [ts, id];
    }
    return out;
  } catch {
    return {};
  }
}

export function chunkForBatch<T>(items: T[], maxSize: number): T[][] {
  if (maxSize < 1) {
    throw new Error('maxSize must be >= 1');
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxSize) {
    chunks.push(items.slice(i, i + maxSize));
  }
  return chunks;
}

/** Split so the sum of per-item write costs stays ≤ maxCost (Firestore tx cap). */
export function chunkByCost<T>(
  items: T[],
  costOf: (item: T) => number,
  maxCost: number,
): T[][] {
  if (maxCost < 1) {
    throw new Error('maxCost must be >= 1');
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  let cost = 0;
  for (const item of items) {
    const itemCost = costOf(item);
    if (itemCost > maxCost) {
      throw new Error('item cost exceeds maxCost');
    }
    if (current.length > 0 && cost + itemCost > maxCost) {
      chunks.push(current);
      current = [];
      cost = 0;
    }
    current.push(item);
    cost += itemCost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function compactRecipeFields(recipe: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    id: recipe.id,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    title: recipe.title,
    servings: recipe.servings,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
    tags: recipe.tags,
  };
  for (const key of [
    'description',
    'sourceUrl',
    'prepMinutes',
    'cookMinutes',
    'notes',
    'photoId',
  ] as const) {
    if (recipe[key] !== undefined) {
      next[key] = recipe[key];
    }
  }
  return next;
}

export type MutationResult =
  | { applied: true; serverUpdatedAt: number }
  | {
      applied: false;
      reason?: string;
      current?: Record<string, unknown>;
    };

function isLiveDoc(data: Record<string, unknown> | undefined): boolean {
  if (!data) {
    return false;
  }
  return data.deletedAt === undefined || data.deletedAt === null;
}

function readStoredState(data: Record<string, unknown> | undefined): StoredMutationState | null {
  if (!data) {
    return null;
  }
  const updatedAt = finiteNumber(data.updatedAt);
  if (updatedAt === undefined) {
    return null;
  }
  const deletedAt = finiteNumber(data.deletedAt);
  return deletedAt !== undefined
    ? { updatedAt, deletedAt }
    : { updatedAt };
}

function tombstonePayload(
  id: string,
  clientUpdatedAt: number,
  serverUpdatedAt: number,
): Record<string, unknown> {
  return {
    id,
    updatedAt: clientUpdatedAt,
    deletedAt: clientUpdatedAt,
    serverUpdatedAt,
  };
}

async function readRecipeLive(
  tx: Transaction,
  uid: string,
  recipeId: string,
): Promise<boolean> {
  const snap = await tx.get(colRef(uid, 'recipes').doc(recipeId));
  if (!snap.exists) {
    return false;
  }
  const data = snap.data() as Record<string, unknown>;
  return isLiveDoc(data);
}

export async function upsertUser(
  uid: string,
  profile: { email: string; name?: string },
): Promise<void> {
  const ref = userRef(uid);
  const now = Date.now();
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base: Record<string, unknown> = {
      email: profile.email,
      lastSeenAt: now,
    };
    if (profile.name !== undefined) {
      base.name = profile.name;
    }
    if (!snap.exists) {
      base.createdAt = now;
    }
    tx.set(ref, base, { merge: true });
  });
}

export async function listChangedSince(
  uid: string,
  kind: StoreKind,
  cursor: CursorTuple | null | undefined,
  limit: number,
): Promise<{
  docs: Record<string, unknown>[];
  cursor: CursorTuple | null;
  hasMore: boolean;
}> {
  let query = colRef(uid, kind)
    .orderBy('serverUpdatedAt')
    .orderBy(FieldPath.documentId())
    .limit(limit + 1);
  if (cursor) {
    query = query.startAfter(cursor[0], cursor[1]);
  }
  const fetched = await query.get();
  const hasMore = fetched.docs.length > limit;
  const slice = hasMore ? fetched.docs.slice(0, limit) : fetched.docs;
  const docs = slice.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return { id: doc.id, ...data };
  });
  let nextCursor: CursorTuple | null = null;
  if (slice.length > 0) {
    const last = slice[slice.length - 1];
    const data = last.data() as Record<string, unknown>;
    const ts = finiteNumber(data.serverUpdatedAt);
    if (ts !== undefined) {
      nextCursor = [ts, last.id];
    }
  }
  return { docs, cursor: nextCursor, hasMore };
}

export async function putDoc(
  uid: string,
  kind: StoreKind,
  id: string,
  payload: Record<string, unknown>,
  clientUpdatedAt: number,
): Promise<MutationResult> {
  const ref = colRef(uid, kind).doc(id);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const storedRaw = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const stored = readStoredState(storedRaw ?? undefined);

    const cmp = compareMutation(stored, clientUpdatedAt, 'put');
    if (!cmp.allow) {
      return {
        applied: false,
        reason: cmp.reason === 'already-deleted' ? 'already-deleted' : undefined,
        current: storedRaw ?? undefined,
      };
    }

    let parentRecipeId: string | null = null;
    if (kind === 'chatMessages') {
      const recipeId = payload.recipeId;
      if (typeof recipeId !== 'string') {
        return { applied: false, reason: 'invalid' };
      }
      parentRecipeId = recipeId;
    } else if (kind === 'cookState') {
      parentRecipeId = id;
    } else if (kind === 'photos') {
      const recipeId = payload.recipeId;
      if (typeof recipeId !== 'string') {
        return { applied: false, reason: 'invalid' };
      }
      parentRecipeId = recipeId;
    }

    if (parentRecipeId !== null) {
      const live = await readRecipeLive(tx, uid, parentRecipeId);
      if (!live) {
        return { applied: false, reason: 'recipe-deleted' };
      }
    }

    const serverUpdatedAt = Date.now();
    let body: Record<string, unknown>;
    if (kind === 'recipes') {
      body = {
        ...compactRecipeFields(payload),
        id,
        updatedAt: clientUpdatedAt,
        serverUpdatedAt,
      };
      if (cmp.undeleting) {
        // deletedAt cleared by omission
      }
    } else {
      body = {
        ...payload,
        id,
        updatedAt: clientUpdatedAt,
        serverUpdatedAt,
      };
      delete body.deletedAt;
      delete body.uid;
      delete body.sub;
    }

    tx.set(ref, body, { merge: false });
    return { applied: true, serverUpdatedAt };
  });
}

export async function tombstoneDoc(
  uid: string,
  kind: StoreKind,
  id: string,
  clientUpdatedAt: number,
): Promise<MutationResult> {
  const ref = colRef(uid, kind).doc(id);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const storedRaw = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const stored = readStoredState(storedRaw ?? undefined);

    const cmp = compareMutation(stored, clientUpdatedAt, 'tombstone');
    if (!cmp.allow) {
      return {
        applied: false,
        current: storedRaw ?? undefined,
      };
    }

    const serverUpdatedAt = Date.now();
    tx.set(ref, tombstonePayload(id, clientUpdatedAt, serverUpdatedAt), { merge: false });
    return { applied: true, serverUpdatedAt };
  });
}

export async function tombstonePhotoWithGcs(
  uid: string,
  photoId: string,
  at: number,
): Promise<MutationResult> {
  const serverUpdatedAt = Date.now();
  return getFirestore().runTransaction(async (tx) => {
    const photoRef = colRef(uid, 'photos').doc(photoId);
    const snap = await tx.get(photoRef);
    const storedRaw = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const stored = readStoredState(storedRaw ?? undefined);
    const cmp = compareMutation(stored, at, 'tombstone');
    if (!cmp.allow) {
      return {
        applied: false,
        current: storedRaw ?? undefined,
      };
    }
    tx.set(photoRef, tombstonePayload(photoId, at, serverUpdatedAt), { merge: false });
    tx.set(
      gcsDeletesRef(uid).doc(photoId),
      { photoId, createdAt: Date.now() },
      { merge: true },
    );
    return { applied: true, serverUpdatedAt };
  });
}

export async function cascadeRecipeDelete(
  uid: string,
  recipeId: string,
  at: number,
): Promise<{ photoIds: string[]; gcsPending: boolean }> {
  let recipePhotoId: string | undefined;

  await getFirestore().runTransaction(async (tx) => {
    const recipeRef = colRef(uid, 'recipes').doc(recipeId);
    const snap = await tx.get(recipeRef);
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      if (isLiveDoc(data) && isUuid(data.photoId)) {
        recipePhotoId = data.photoId as string;
      }
      const stored = readStoredState(data);
      const cmp = compareMutation(stored, at, 'tombstone');
      if (cmp.allow) {
        const serverUpdatedAt = Date.now();
        tx.set(recipeRef, tombstonePayload(recipeId, at, serverUpdatedAt), { merge: false });
      }
    } else {
      const serverUpdatedAt = Date.now();
      tx.set(recipeRef, tombstonePayload(recipeId, at, serverUpdatedAt), { merge: false });
    }
  });

  const photoIds = new Set<string>();
  if (recipePhotoId !== undefined) {
    photoIds.add(recipePhotoId);
  }

  const chatSnap = await colRef(uid, 'chatMessages').where('recipeId', '==', recipeId).get();
  const chatIds: string[] = [];
  for (const doc of chatSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      chatIds.push(doc.id);
      for (const pid of (data.photoIds as string[] | undefined) ?? []) {
        if (isUuid(pid)) {
          photoIds.add(pid);
        }
      }
    }
  }

  const cookRef = colRef(uid, 'cookState').doc(recipeId);
  const cookSnap = await cookRef.get();
  const cookIds: string[] = [];
  if (cookSnap.exists) {
    const data = cookSnap.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      cookIds.push(recipeId);
    }
  }

  const photosSnap = await colRef(uid, 'photos').where('recipeId', '==', recipeId).get();
  for (const doc of photosSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      photoIds.add(doc.id);
    }
  }

  const childJobs: { kind: StoreKind; id: string }[] = [
    ...chatIds.map((id) => ({ kind: 'chatMessages' as StoreKind, id })),
    ...cookIds.map((id) => ({ kind: 'cookState' as StoreKind, id })),
    ...[...photoIds].map((id) => ({ kind: 'photos' as StoreKind, id })),
  ];

  for (const chunk of chunkByCost(
    childJobs,
    (job) => (job.kind === 'photos' ? 2 : 1),
    400,
  )) {
    const serverUpdatedAt = Date.now();
    await getFirestore().runTransaction(async (tx) => {
      for (const job of chunk) {
        if (job.kind === 'photos') {
          const photoRef = colRef(uid, 'photos').doc(job.id);
          const snap = await tx.get(photoRef);
          const stored = readStoredState(
            snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
          );
          const cmp = compareMutation(stored, at, 'tombstone');
          if (cmp.allow) {
            tx.set(photoRef, tombstonePayload(job.id, at, serverUpdatedAt), { merge: false });
            tx.set(
              gcsDeletesRef(uid).doc(job.id),
              { photoId: job.id, createdAt: Date.now() },
              { merge: true },
            );
          }
        } else {
          const ref = colRef(uid, job.kind).doc(job.id);
          const snap = await tx.get(ref);
          const stored = readStoredState(
            snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
          );
          const cmp = compareMutation(stored, at, 'tombstone');
          if (cmp.allow) {
            tx.set(ref, tombstonePayload(job.id, at, serverUpdatedAt), { merge: false });
          }
        }
      }
    });
  }

  return { photoIds: [...photoIds], gcsPending: photoIds.size > 0 };
}

export async function clearChatForRecipe(
  uid: string,
  recipeId: string,
  at: number,
): Promise<void> {
  const messagesSnap = await colRef(uid, 'chatMessages')
    .where('recipeId', '==', recipeId)
    .get();

  const toTombstone: string[] = [];
  const photoIds = new Set<string>();

  for (const doc of messagesSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const createdAt = finiteNumber(data.createdAt);
    if (createdAt !== undefined && createdAt <= at && isLiveDoc(data)) {
      toTombstone.push(doc.id);
      for (const pid of (data.photoIds as string[] | undefined) ?? []) {
        if (isUuid(pid)) {
          photoIds.add(pid);
        }
      }
    } else if (isLiveDoc(data)) {
      for (const pid of (data.photoIds as string[] | undefined) ?? []) {
        if (isUuid(pid)) {
          photoIds.add(pid);
        }
      }
    }
  }

  for (const chunk of chunkForBatch(toTombstone, 400)) {
    const serverUpdatedAt = Date.now();
    await getFirestore().runTransaction(async (tx) => {
      for (const messageId of chunk) {
        const ref = colRef(uid, 'chatMessages').doc(messageId);
        const snap = await tx.get(ref);
        const stored = readStoredState(
          snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
        );
        const cmp = compareMutation(stored, at, 'tombstone');
        if (cmp.allow) {
          tx.set(ref, tombstonePayload(messageId, at, serverUpdatedAt), { merge: false });
        }
      }
    });
  }

  for (const photoId of photoIds) {
    await tombstonePhotoWithGcs(uid, photoId, at);
  }
}

// --- push op validation (pure) ---

export type PushOpKind =
  | 'recipe.put'
  | 'recipe.delete'
  | 'chat.put'
  | 'chat.clearForRecipe'
  | 'cookState.put'
  | 'photo.delete';

export interface PushOpBase {
  kind: PushOpKind;
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function validateRecipePut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.id)) {
    return false;
  }
  if (typeof payload.title !== 'string' || payload.title.trim() === '') {
    return false;
  }
  const servings = finiteNumber(payload.servings);
  if (servings === undefined) {
    return false;
  }
  if (!Array.isArray(payload.ingredientSections) || !Array.isArray(payload.steps)) {
    return false;
  }
  if (!Array.isArray(payload.tags)) {
    return false;
  }
  if (finiteNumber(payload.createdAt) === undefined || finiteNumber(payload.updatedAt) === undefined) {
    return false;
  }
  if (jsonSize(payload) >= 200_000) {
    return false;
  }
  return true;
}

function validateRecipeDelete(payload: unknown): payload is { id: string; updatedAt: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const updatedAt = finiteNumber(payload.updatedAt);
  return isUuid(payload.id) && updatedAt !== undefined;
}

function validateChatPut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.id) || !isUuid(payload.recipeId)) {
    return false;
  }
  if (payload.role !== 'user' && payload.role !== 'assistant') {
    return false;
  }
  if (typeof payload.content !== 'string') {
    return false;
  }
  if (payload.content.length > 20_000) {
    return false;
  }
  if (finiteNumber(payload.createdAt) === undefined) {
    return false;
  }
  if (payload.photoIds !== undefined) {
    if (!Array.isArray(payload.photoIds) || payload.photoIds.length > 8) {
      return false;
    }
    for (const pid of payload.photoIds) {
      if (!isUuid(pid)) {
        return false;
      }
    }
  }
  if (jsonSize(payload) >= 200_000) {
    return false;
  }
  return true;
}

function validateClearForRecipe(payload: unknown): payload is { recipeId: string; at: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const at = finiteNumber(payload.at);
  return isUuid(payload.recipeId) && at !== undefined;
}

function validateCookStatePut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.recipeId)) {
    return false;
  }
  const fields = [
    'servings',
    'currentStep',
    'updatedAt',
    'recipeUpdatedAt',
  ] as const;
  for (const field of fields) {
    if (finiteNumber(payload[field]) === undefined) {
      return false;
    }
  }
  if (!Array.isArray(payload.checkedKeys)) {
    return false;
  }
  if (payload.checkedKeys.length > 500) {
    return false;
  }
  for (const key of payload.checkedKeys) {
    if (typeof key !== 'string') {
      return false;
    }
  }
  return true;
}

function validatePhotoDelete(payload: unknown): payload is { id: string; updatedAt: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const updatedAt = finiteNumber(payload.updatedAt);
  return isUuid(payload.id) && updatedAt !== undefined;
}

export function validatePushOp(op: unknown): { ok: true; op: { kind: PushOpKind; payload: unknown } } | { ok: false } {
  if (!isPlainObject(op)) {
    return { ok: false };
  }
  const kind = op.kind;
  if (typeof kind !== 'string') {
    return { ok: false };
  }
  const payload = op.payload;
  switch (kind) {
    case 'recipe.put':
      return validateRecipePut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'recipe.delete':
      return validateRecipeDelete(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'chat.put':
      return validateChatPut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'chat.clearForRecipe':
      return validateClearForRecipe(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'cookState.put':
      return validateCookStatePut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'photo.delete':
      return validatePhotoDelete(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    default:
      return { ok: false };
  }
}

export function isKnownPushKind(kind: unknown): kind is PushOpKind {
  return (
    kind === 'recipe.put' ||
    kind === 'recipe.delete' ||
    kind === 'chat.put' ||
    kind === 'chat.clearForRecipe' ||
    kind === 'cookState.put' ||
    kind === 'photo.delete'
  );
}

export function messageIdsToClearAtBoundary(
  messages: { id: string; createdAt: number }[],
  at: number,
): string[] {
  return messages.filter((m) => m.createdAt <= at).map((m) => m.id);
}
