import {
  MAX_LIVE_GRANTS,
  NO_ACCOUNT_MESSAGE,
  addGrantTransition,
  cascadeCollectionGrants,
  collectionLiveForGrant,
  grantColRef,
  incomingSharePayload,
  incomingShareRef,
  isLiveGrant,
  lookupAdmittedSubByEmail,
  normalizeShareEmail,
  parseGrantDoc,
  revokeGrantTransition,
  shareGrantId,
} from './grants.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
} from './membership.ts';
import {
  collectionDocRef,
  getStoreFirestore,
  isLiveDoc,
  isUuid,
  readDocData,
} from './store.ts';

const BODY_LIMIT = 8_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function notFound(): Response {
  return jsonResponse({ error: 'Not found' }, 404);
}

/** Maps in-transaction owner collection read to grant-post HTTP status. */
export function grantPostHttpStatusForCollectionRead(
  collectionData: Record<string, unknown> | undefined,
): 404 | null {
  return collectionLiveForGrant(collectionData) ? null : 404;
}

export function collectionIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/api\/collections\/([^/]+)\/grants(?:\/revoke)?$/,
  );
  if (!match) {
    return null;
  }
  const id = match[1];
  return isUuid(id) ? id : null;
}

async function requireOwnedLiveCollection(
  req: Request,
  collectionId: string,
): Promise<
  | { kind: 'ok'; sub: string; email: string }
  | { kind: 'denied' }
  | { kind: 'unknown' }
  | { kind: 'missing' }
> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return { kind: 'denied' };
  }
  if (access.kind === 'unknown') {
    return { kind: 'unknown' };
  }
  try {
    const collection = await readDocData(access.sub, 'collections', collectionId);
    if (collection === undefined || !isLiveDoc(collection)) {
      return { kind: 'missing' };
    }
    return { kind: 'ok', sub: access.sub, email: access.email };
  } catch {
    return { kind: 'unknown' };
  }
}

function accessResponse(
  access: Awaited<ReturnType<typeof requireOwnedLiveCollection>>,
): Response | null {
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }
  if (access.kind === 'missing') {
    return notFound();
  }
  return null;
}

export async function collectionGrantsGet(req: Request): Promise<Response> {
  const collectionId = collectionIdFromPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const access = await requireOwnedLiveCollection(req, collectionId);
  const early = accessResponse(access);
  if (early) {
    return early;
  }
  if (access.kind !== 'ok') {
    return notFound();
  }
  try {
    const snap = await grantColRef(access.sub, collectionId).get();
    const grants: Array<{ sub: string; email: string; createdAt: number }> = [];
    for (const doc of snap.docs) {
      const parsed = parseGrantDoc(doc.data(), doc.id);
      if (!isLiveGrant(parsed)) {
        continue;
      }
      grants.push({
        sub: parsed.viewerSub,
        email: parsed.email,
        createdAt: parsed.createdAt,
      });
    }
    grants.sort((a, b) => a.createdAt - b.createdAt);
    return jsonResponse({ grants });
  } catch (err) {
    console.error('collectionGrantsGet store error:', err);
    return storeUnavailable();
  }
}

export async function collectionGrantsPost(req: Request): Promise<Response> {
  const collectionId = collectionIdFromPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const access = await requireOwnedLiveCollection(req, collectionId);
  const early = accessResponse(access);
  if (early) {
    return early;
  }
  if (access.kind !== 'ok') {
    return notFound();
  }

  const raw = await readBoundedText(req, BODY_LIMIT);
  if (raw === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  let body: unknown;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const email = normalizeShareEmail(
    body && typeof body === 'object' && 'email' in body
      ? (body as { email?: unknown }).email
      : undefined,
  );
  if (email === undefined) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  const target = await lookupAdmittedSubByEmail(email, {
    sub: access.sub,
    email: access.email,
  });
  if (target.kind === 'self') {
    return jsonResponse({ error: 'Cannot share with yourself' }, 400);
  }
  if (target.kind === 'unknown') {
    return membershipUnavailable();
  }
  if (target.kind === 'notFound') {
    return jsonResponse({ error: NO_ACCOUNT_MESSAGE }, 404);
  }

  try {
    const grantRef = grantColRef(access.sub, collectionId).doc(target.sub);
    const shareRef = incomingShareRef(
      target.sub,
      shareGrantId(access.sub, collectionId),
    );
    const db = getStoreFirestore();
    const outcome = await db.runTransaction(async (tx) => {
      const allGrants = await tx.get(grantColRef(access.sub, collectionId));
      const collectionSnap = await tx.get(collectionDocRef(access.sub, collectionId));
      const collectionData = collectionSnap.exists
        ? (collectionSnap.data() as Record<string, unknown>)
        : undefined;
      if (grantPostHttpStatusForCollectionRead(collectionData) === 404) {
        return { kind: 'collectionMissing' as const };
      }
      const grantSnap = allGrants.docs.find((doc) => doc.id === target.sub);
      const existing = parseGrantDoc(
        grantSnap?.exists ? grantSnap.data() : undefined,
        target.sub,
      );
      let liveCount = 0;
      for (const doc of allGrants.docs) {
        if (isLiveGrant(parseGrantDoc(doc.data(), doc.id))) {
          liveCount += 1;
        }
      }
      const next = addGrantTransition({
        existing,
        viewerSub: target.sub,
        email: target.email.trim().toLowerCase(),
        collectionId,
        now: Date.now(),
        liveCount,
      });
      if (next.kind === 'cap') {
        return { kind: 'cap' as const };
      }
      if (next.kind === 'idempotent') {
        return { kind: 'idempotent' as const, doc: next.doc };
      }
      tx.set(grantRef, next.doc, { merge: false });
      tx.set(
        shareRef,
        incomingSharePayload(access.sub, collectionId, next.doc.updatedAt, {
          ownerEmail: access.email,
        }),
        { merge: false },
      );
      return { kind: 'write' as const, doc: next.doc };
    });
    if (outcome.kind === 'collectionMissing') {
      return notFound();
    }
    if (outcome.kind === 'cap') {
      return jsonResponse(
        { error: `This collection already has ${MAX_LIVE_GRANTS} people` },
        409,
      );
    }
    return jsonResponse({
      grant: {
        sub: outcome.doc.viewerSub,
        email: outcome.doc.email,
        createdAt: outcome.doc.createdAt,
      },
    });
  } catch (err) {
    console.error('collectionGrantsPost store error:', err);
    return storeUnavailable();
  }
}

export async function collectionGrantsRevokePost(req: Request): Promise<Response> {
  const collectionId = collectionIdFromPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const access = await requireOwnedLiveCollection(req, collectionId);
  const early = accessResponse(access);
  if (early) {
    return early;
  }
  if (access.kind !== 'ok') {
    return notFound();
  }

  const raw = await readBoundedText(req, BODY_LIMIT);
  if (raw === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  let body: unknown;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const sub =
    body && typeof body === 'object' && typeof (body as { sub?: unknown }).sub === 'string'
      ? (body as { sub: string }).sub.trim()
      : '';
  if (sub === '') {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  try {
    const grantRef = grantColRef(access.sub, collectionId).doc(sub);
    const shareRef = incomingShareRef(sub, shareGrantId(access.sub, collectionId));
    const db = getStoreFirestore();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(grantRef);
      const existing = parseGrantDoc(snap.exists ? snap.data() : undefined, sub);
      const next = revokeGrantTransition({
        existing,
        viewerSub: sub,
        now: Date.now(),
      });
      tx.set(grantRef, next.doc, { merge: false });
      tx.set(
        shareRef,
        incomingSharePayload(access.sub, collectionId, next.doc.updatedAt, {
          deletedAt: next.doc.deletedAt,
        }),
        { merge: false },
      );
    });
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('collectionGrantsRevokePost store error:', err);
    return storeUnavailable();
  }
}

export { cascadeCollectionGrants };
