import { compactCollection } from './compactCollection';
import { compactRecipe } from './compactRecipe';
import { MAX_PUSH_OPS, type PushOp } from './pushOps';
import {
  isDiscardedPushReason,
  type DiscardedPushReason,
} from './pushReasons';
import { invalidateSession } from './session';
import type { ChatMessage, Collection, Recipe } from './types';
import type { CookStateRow } from './useCookState';
import { clearLibrary } from './libraryMemory';

export type PullCursor = Partial<
  Record<'recipes' | 'chatMessages' | 'cookState' | 'photos' | 'collections', [number, string]>
>;

export type PullChanges = {
  recipes: Record<string, unknown>[];
  chatMessages: Record<string, unknown>[];
  cookState: Record<string, unknown>[];
  photos: Record<string, unknown>[];
  collections?: Record<string, unknown>[];
};

export type PullPage = {
  changes: PullChanges;
  cursor: PullCursor;
  hasMore: boolean;
};

export type RemoteResult =
  | 'ok'
  | 'signedOut'
  | 'error'
  | DiscardedPushReason;

function jsonHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' };
}

export function mergePullCursor(prev: PullCursor, next: PullCursor): PullCursor {
  return { ...prev, ...next };
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

async function readErrorStatus(response: Response): Promise<'signedOut' | 'error'> {
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return 'signedOut';
  }
  return 'error';
}

export async function pullPage(cursor: PullCursor | null): Promise<PullPage | 'signedOut' | 'error'> {
  const params = new URLSearchParams({ limit: '200' });
  if (cursor !== null && Object.keys(cursor).length > 0) {
    params.set('cursor', encodePullCursor(cursor));
  }
  let response: Response;
  try {
    response = await fetch(`/api/sync/pull?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return 'error';
  }
  if (!response.ok) {
    return readErrorStatus(response);
  }
  const body = (await response.json()) as {
    changes?: PullChanges;
    cursor?: PullCursor;
    hasMore?: boolean;
  };
  if (!body.changes) {
    return 'error';
  }
  return {
    changes: body.changes,
    cursor: body.cursor ?? {},
    hasMore: Boolean(body.hasMore),
  };
}

/**
 * A 200 still carries per-op verdicts. `stale`, `already-deleted` and
 * `recipe-deleted` are ordinary last-write-wins/cascade outcomes, but
 * `invalid`, `unknown`, and `cap` mean the server threw the write away —
 * report those so callers roll back instead of claiming a save that never
 * landed. `cap` is the live-collection limit, not a malformed payload.
 */
export function firstPushRejection(body: unknown): DiscardedPushReason | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return null;
  }
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { applied, reason } = entry as { applied?: unknown; reason?: unknown };
    if (applied === false && typeof reason === 'string' && isDiscardedPushReason(reason)) {
      return reason;
    }
  }
  return null;
}

export async function pushOps(ops: PushOp[]): Promise<RemoteResult> {
  for (let offset = 0; offset < ops.length; offset += MAX_PUSH_OPS) {
    const batch = ops.slice(offset, offset + MAX_PUSH_OPS);
    let response: Response;
    try {
      response = await fetch('/api/sync/push', {
        method: 'POST',
        credentials: 'same-origin',
        headers: jsonHeaders(),
        body: JSON.stringify({ ops: batch }),
      });
    } catch {
      return 'error';
    }
    if (!response.ok) {
      return readErrorStatus(response);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return 'error';
    }
    const rejected = firstPushRejection(body);
    if (rejected !== null) {
      return rejected;
    }
  }
  return 'ok';
}

const PHOTO_UPLOAD_JPEG = 'image/jpeg';
const PHOTO_UPLOAD_PNG = 'image/png';

export async function resolvePhotoUploadContentType(
  blob: Blob,
): Promise<'image/jpeg' | 'image/png' | null> {
  const declared = blob.type;
  if (declared === PHOTO_UPLOAD_JPEG || declared === PHOTO_UPLOAD_PNG) {
    return declared;
  }
  if (declared !== '' && declared !== 'application/octet-stream') {
    return null;
  }
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (
    head.length >= 4 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return PHOTO_UPLOAD_PNG;
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return PHOTO_UPLOAD_JPEG;
  }
  return PHOTO_UPLOAD_JPEG;
}

export async function postPhoto(
  id: string,
  recipeId: string,
  updatedAt: number,
  blob: Blob,
): Promise<RemoteResult | 'unavailable'> {
  const contentType = await resolvePhotoUploadContentType(blob);
  if (contentType === null) {
    return 'error';
  }
  let response: Response;
  try {
    response = await fetch(`/api/photos/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': contentType,
        'x-photo-updated-at': String(updatedAt),
        'x-recipe-id': recipeId,
      },
      body: blob,
    });
  } catch {
    return 'error';
  }
  if (response.status === 200) {
    return 'ok';
  }
  if (response.status === 503) {
    return 'unavailable';
  }
  return readErrorStatus(response);
}

export async function fetchPhotoBlob(
  id: string,
  ownerSub?: string,
): Promise<Blob | null | 'signedOut'> {
  let response: Response;
  try {
    const params = ownerSub ? `?owner=${encodeURIComponent(ownerSub)}` : '';
    response = await fetch(`/api/photos/${encodeURIComponent(id)}${params}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return 'signedOut';
  }
  if (!response.ok) {
    return null;
  }
  return response.blob();
}

export function normalizeRecipeChange(raw: Record<string, unknown>): Recipe | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  return compactRecipe(raw as unknown as Recipe);
}

export function normalizeChatChange(raw: Record<string, unknown>): ChatMessage | 'tombstone' {
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

export function normalizeCookChange(
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

export function applyPullChanges(
  acc: {
    recipes: Map<string, Recipe>;
    collections: Map<string, Collection>;
    chat: Map<string, ChatMessage>;
    cook: Map<string, CookStateRow>;
    remotePhotoIds: Set<string>;
  },
  changes: PullChanges,
): void {
  for (const raw of changes.recipes) {
    const id = raw.id as string;
    const normalized = normalizeRecipeChange(raw);
    if (normalized === 'tombstone') {
      acc.recipes.delete(id);
    } else {
      acc.recipes.set(id, normalized);
    }
  }
  for (const raw of changes.collections ?? []) {
    const id = raw.id as string;
    const normalized = normalizeCollectionChange(raw);
    if (normalized === 'tombstone') {
      acc.collections.delete(id);
    } else {
      acc.collections.set(id, normalized);
    }
  }
  for (const raw of changes.chatMessages) {
    const id = raw.id as string;
    const normalized = normalizeChatChange(raw);
    if (normalized === 'tombstone') {
      acc.chat.delete(id);
    } else {
      acc.chat.set(id, normalized);
    }
  }
  for (const raw of changes.cookState) {
    const recipeId = (raw.recipeId ?? raw.id) as string;
    const normalized = normalizeCookChange(raw);
    if (normalized === 'tombstone') {
      acc.cook.delete(recipeId);
    } else {
      acc.cook.set(recipeId, normalized);
    }
  }
  for (const raw of changes.photos) {
    const id = raw.id as string;
    if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
      acc.remotePhotoIds.delete(id);
    } else {
      acc.remotePhotoIds.add(id);
    }
  }
}

export function normalizeCollectionChange(raw: Record<string, unknown>): Collection | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  return compactCollection({
    id: raw.id as string,
    name: typeof raw.name === 'string' ? raw.name : '',
    recipeIds: Array.isArray(raw.recipeIds) ? (raw.recipeIds as string[]) : [],
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
  });
}

export type SharedPullChanges = {
  collections: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  photos: Record<string, unknown>[];
};

export type SharedPullPage = {
  changes: SharedPullChanges;
  cursorToken: string;
  hasMore: boolean;
};

export async function pullSharedPage(
  cursorToken: string | null,
): Promise<SharedPullPage | 'signedOut' | 'error'> {
  const params = new URLSearchParams({ limit: '200' });
  if (cursorToken) {
    params.set('cursor', cursorToken);
  }
  let response: Response;
  try {
    response = await fetch(`/api/sync/shared?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return 'error';
  }
  if (!response.ok) {
    return readErrorStatus(response);
  }
  const body = (await response.json()) as {
    changes?: SharedPullChanges;
    cursorToken?: string;
    hasMore?: boolean;
  };
  if (!body.changes) {
    return 'error';
  }
  return {
    changes: body.changes,
    cursorToken: typeof body.cursorToken === 'string' ? body.cursorToken : '',
    hasMore: Boolean(body.hasMore),
  };
}

export type CollectionGrant = { sub: string; email: string; createdAt: number };

export type GrantHttpResult =
  | { kind: 'ok'; grants?: CollectionGrant[]; grant?: CollectionGrant }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string; status?: number };

async function grantRequest(
  path: string,
  init?: RequestInit,
): Promise<GrantHttpResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
  } catch {
    return { kind: 'error', message: "Couldn't update sharing." };
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return { kind: 'signedOut' };
  }
  if (response.status === 503) {
    return { kind: 'error', message: 'Sharing is temporarily unavailable.', status: 503 };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : "Couldn't update sharing.";
    return { kind: 'error', message, status: response.status };
  }
  return {
    kind: 'ok',
    grants: (body as { grants?: CollectionGrant[] }).grants,
    grant: (body as { grant?: CollectionGrant }).grant,
  };
}

export async function listCollectionGrants(
  collectionId: string,
): Promise<GrantHttpResult> {
  return grantRequest(`/api/collections/${encodeURIComponent(collectionId)}/grants`);
}

export async function addCollectionGrant(
  collectionId: string,
  email: string,
): Promise<GrantHttpResult> {
  return grantRequest(`/api/collections/${encodeURIComponent(collectionId)}/grants`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email }),
  });
}

export async function revokeCollectionGrant(
  collectionId: string,
  sub: string,
): Promise<GrantHttpResult> {
  return grantRequest(
    `/api/collections/${encodeURIComponent(collectionId)}/grants/revoke`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sub }),
    },
  );
}
