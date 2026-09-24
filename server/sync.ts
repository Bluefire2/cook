import {
  canonicalCollectionTombstoneAt,
  cascadeCollectionGrants,
  listLiveIncomingShares,
  readLiveIncomingShare,
  sharingOwnerAdmitted,
} from './grants.ts';
import { drainGcsDeletes } from './photos.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  requireMember,
  storeUnavailable,
} from './membership.ts';
import {
  buildSharedPullPage,
  decodeSharedCursor,
  encodeSharedCursor,
} from './sharedPull.ts';
import {
  addedCollectionRecipeIds,
  cascadeRecipeDelete,
  clearChatForRecipe,
  compactCollectionFields,
  compactRecipeFields,
  countLiveNamedCollections,
  decodePullCursor,
  isKnownPushKind,
  isLiveDoc,
  listChangedSince,
  MAX_NAMED_COLLECTIONS,
  putDoc,
  readDocData,
  readDocsData,
  readTombstonedRecipeIds,
  recipeIdsWithoutTombstones,
  tombstoneDoc,
  tombstonePhotoWithGcs,
  type MutationResult,
  type PullCursor,
  type PushRejectReason,
  type StoreKind,
  validatePushOp,
} from './store.ts';

/** Pick the accepted or stored canonical tombstone timestamp for a grant cascade. */
export function collectionDeleteCascadeAt(
  result: MutationResult,
  acceptedAt: number,
): number | undefined {
  if (result.applied) {
    return acceptedAt;
  }
  return canonicalCollectionTombstoneAt(result.current);
}

const STORE_KINDS: StoreKind[] = ['recipes', 'chatMessages', 'cookState', 'photos', 'collections'];

const MAX_PUSH_OPS = 50;
const MAX_PUSH_BYTES = 1_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function docToChange(kind: StoreKind, doc: Record<string, unknown>): Record<string, unknown> {
  const deletedAt = doc.deletedAt;
  if (deletedAt !== undefined && deletedAt !== null) {
    return { id: doc.id, deletedAt };
  }
  const copy = { ...doc };
  delete copy.serverUpdatedAt;
  delete copy.deletedAt;
  if (kind === 'recipes') {
    return compactRecipeFields(copy);
  }
  if (kind === 'collections') {
    return compactCollectionFields(copy);
  }
  if (kind === 'photos') {
    return {
      id: copy.id,
      recipeId: copy.recipeId,
      contentType: copy.contentType,
      size: copy.size,
      createdAt: copy.createdAt,
    };
  }
  return copy;
}

function mergeCursors(prev: PullCursor, kind: StoreKind, cursor: [number, string] | null): PullCursor {
  const next = { ...prev };
  if (cursor) {
    next[kind] = cursor;
  }
  return next;
}

export async function syncPull(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  try {
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  let limit = 200;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (Number.isFinite(parsed)) {
      limit = Math.min(500, Math.max(1, Math.floor(parsed)));
    }
  }

  const cursor = decodePullCursor(url.searchParams.get('cursor'));

  const changes: Record<StoreKind, Record<string, unknown>[]> = {
    recipes: [],
    chatMessages: [],
    cookState: [],
    photos: [],
    collections: [],
  };

  let nextCursor: PullCursor = { ...cursor };
  let hasMore = false;

  for (const kind of STORE_KINDS) {
    const page = await listChangedSince(access.sub, kind, cursor[kind], limit);
    changes[kind] = page.docs.map((doc) => docToChange(kind, doc));
    nextCursor = mergeCursors(nextCursor, kind, page.cursor);
    if (page.hasMore) {
      hasMore = true;
    }
  }

  return jsonResponse({
    user: { sub: access.sub, email: access.email },
    changes,
    cursor: nextCursor,
    hasMore,
  });
  } catch (err) {
    console.error('syncPull store error:', err);
    return storeUnavailable();
  }
}

export type PushResult = {
  index: number;
  applied: boolean;
  reason?: PushRejectReason;
  current?: Record<string, unknown>;
};

export async function applyPushOp(
  uid: string,
  op: { kind: string; payload: unknown },
): Promise<{ applied: boolean; reason?: PushRejectReason; current?: Record<string, unknown> }> {
  if (!isKnownPushKind(op.kind)) {
    return { applied: false, reason: 'unknown' };
  }
  const validated = validatePushOp(op);
  if (!validated.ok) {
    return { applied: false, reason: 'invalid' };
  }
  const { kind, payload } = validated.op;

  switch (kind) {
    case 'recipe.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const updatedAt = body.updatedAt as number;
      const compact = compactRecipeFields(body);
      return putDoc(uid, 'recipes', id, compact, updatedAt);
    }
    case 'recipe.delete': {
      const body = payload as { id: string; updatedAt: number };
      await cascadeRecipeDelete(uid, body.id, body.updatedAt);
      return { applied: true };
    }
    case 'chat.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const createdAt = body.createdAt;
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
        return { applied: false, reason: 'invalid' };
      }
      const messageBody = { ...body, updatedAt: createdAt };
      return putDoc(uid, 'chatMessages', id, messageBody, createdAt);
    }
    case 'chat.clearForRecipe': {
      const body = payload as { recipeId: string; at: number };
      await clearChatForRecipe(uid, body.recipeId, body.at);
      return { applied: true };
    }
    case 'cookState.put': {
      const body = payload as Record<string, unknown>;
      const recipeId = body.recipeId as string;
      const updatedAt = body.updatedAt as number;
      return putDoc(uid, 'cookState', recipeId, body, updatedAt);
    }
    case 'photo.delete': {
      const body = payload as { id: string; updatedAt: number };
      return tombstonePhotoWithGcs(uid, body.id, body.updatedAt);
    }
    case 'collection.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const updatedAt = body.updatedAt as number;
      const existing = await readDocData(uid, 'collections', id);
      if (!isLiveDoc(existing)) {
        const live = await countLiveNamedCollections(uid);
        if (live >= MAX_NAMED_COLLECTIONS) {
          return { applied: false, reason: 'cap' };
        }
      }
      const compact = compactCollectionFields(body);
      const recipeIds = Array.isArray(compact.recipeIds)
        ? compact.recipeIds.filter((recipeId): recipeId is string => typeof recipeId === 'string')
        : [];
      const addedRecipeIds = addedCollectionRecipeIds(existing, recipeIds);
      // This preflight is intentionally outside putDoc's transaction. A concurrent
      // recipe delete may briefly win this race, but its membership cascade converges.
      const tombstonedRecipeIds = await readTombstonedRecipeIds(uid, addedRecipeIds);
      return putDoc(
        uid,
        'collections',
        id,
        {
          ...compact,
          recipeIds: recipeIdsWithoutTombstones(recipeIds, tombstonedRecipeIds),
        },
        updatedAt,
      );
    }
    case 'collection.delete': {
      const body = payload as { id: string; updatedAt: number };
      const result = await tombstoneDoc(uid, 'collections', body.id, body.updatedAt);
      const cascadeAt = collectionDeleteCascadeAt(result, body.updatedAt);
      if (cascadeAt !== undefined) {
        await cascadeCollectionGrants(uid, body.id, cascadeAt);
      }
      return result;
    }
    default:
      return { applied: false, reason: 'unknown' };
  }
}

export async function syncPush(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  if (raw.length > MAX_PUSH_BYTES) {
    return jsonResponse({ error: 'Payload too large; batch your ops' }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  if (!body || typeof body !== 'object' || !Array.isArray((body as { ops?: unknown }).ops)) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  const ops = (body as { ops: unknown[] }).ops;
  if (ops.length > MAX_PUSH_OPS) {
    return jsonResponse({ error: 'Too many ops; batch your requests' }, 413);
  }

  const uid = access.sub;

  try {
  const results: PushResult[] = [];
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (!op || typeof op !== 'object') {
      results.push({ index, applied: false, reason: 'invalid' });
      continue;
    }
    const record = op as Record<string, unknown>;
    if (record.uid !== undefined || record.sub !== undefined) {
      // ignored — uid comes only from session
    }
    const kind = record.kind;
    const payload = record.payload;
    const outcome = await applyPushOp(uid, { kind: kind as string, payload });
    results.push({
      index,
      applied: outcome.applied,
      reason: outcome.reason,
      current: outcome.current,
    });
  }

  await drainGcsDeletes(uid);

  return jsonResponse({ results });
  } catch (err) {
    console.error('syncPush store error:', err);
    return storeUnavailable();
  }
}

export async function syncSharedPull(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    let limit = 200;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (Number.isFinite(parsed)) {
        limit = Math.min(500, Math.max(1, Math.floor(parsed)));
      }
    }
    const cursor = decodeSharedCursor(url.searchParams.get('cursor'));
    const page = await buildSharedPullPage({
      viewerSub: access.sub,
      cursor,
      limit,
      listLiveIncomingShares,
      readLiveIncomingShare,
      ownerAdmitted: sharingOwnerAdmitted,
      readDocData,
      readDocsData,
    });
    return jsonResponse({
      changes: page.changes,
      cursor: page.cursor,
      cursorToken: encodeSharedCursor(page.cursor),
      hasMore: page.hasMore,
    });
  } catch (err) {
    console.error('syncSharedPull store error:', err);
    return storeUnavailable();
  }
}

export { encodePullCursor, decodePullCursor } from './store.ts';
