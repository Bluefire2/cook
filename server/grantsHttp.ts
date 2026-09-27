import {
  MAX_LIVE_GRANTS,
  NO_ACCOUNT_MESSAGE,
  collectionLiveForGrant,
  commitCollectionGrant,
  grantColRef,
  incomingSharePayload,
  incomingShareRef,
  isSafeFirestoreDocumentId,
  isLiveGrant,
  lookupAdmittedSubByEmail,
  normalizeShareEmail,
  orchestrateGrantRevoke,
  parseGrantDoc,
  shareGrantId,
  type RevokeGrantOutcome,
} from './grants.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
} from './membership.ts';
import {
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

function errorJson(code: string, error: string, status: number, max?: number): Response {
  const body: { error: string; code: string; max?: number } = { error, code };
  if (max !== undefined) {
    body.max = max;
  }
  return jsonResponse(body, status);
}

function badRequest(): Response {
  return errorJson('bad-request', 'Bad request', 400);
}

function notFound(): Response {
  return errorJson('not-found', 'Not found', 404);
}

export function shareGrantErrorResponse(kind: 'self' | 'no-account' | 'full'): Response {
  if (kind === 'self') {
    return errorJson('share-self', 'Cannot share with yourself', 400);
  }
  if (kind === 'no-account') {
    return errorJson('share-no-account', NO_ACCOUNT_MESSAGE, 404);
  }
  return errorJson(
    'share-full',
    `This collection already has ${MAX_LIVE_GRANTS} people`,
    409,
    MAX_LIVE_GRANTS,
  );
}

export function revokeGrantHttpResponse(
  outcome: RevokeGrantOutcome,
): Response {
  if (outcome.kind === 'badRequest') {
    return badRequest();
  }
  if (outcome.kind === 'missing') {
    return notFound();
  }
  return jsonResponse({ ok: true });
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
    return badRequest();
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
    return badRequest();
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
    return badRequest();
  }
  let body: unknown;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return badRequest();
  }
  const email = normalizeShareEmail(
    body && typeof body === 'object' && 'email' in body
      ? (body as { email?: unknown }).email
      : undefined,
  );
  if (email === undefined) {
    return badRequest();
  }

  const target = await lookupAdmittedSubByEmail(email, {
    sub: access.sub,
    email: access.email,
  });
  if (target.kind === 'self') {
    return shareGrantErrorResponse('self');
  }
  if (target.kind === 'unknown') {
    return membershipUnavailable();
  }
  if (target.kind === 'notFound') {
    return shareGrantErrorResponse('no-account');
  }

  try {
    const outcome = await commitCollectionGrant({
      ownerSub: access.sub,
      ownerEmail: access.email,
      collectionId,
      viewerSub: target.sub,
      email: target.email.trim().toLowerCase(),
    });
    if (outcome.kind === 'collectionMissing') {
      return notFound();
    }
    if (outcome.kind === 'cap') {
      return shareGrantErrorResponse('full');
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

export type RevokeGrantRequestDependencies = {
  requireOwnedLiveCollection: (
    req: Request,
    collectionId: string,
  ) => Promise<Awaited<ReturnType<typeof requireOwnedLiveCollection>>>;
  revoke: (
    ownerSub: string,
    collectionId: string,
    viewerSub: string,
  ) => Promise<RevokeGrantOutcome>;
};

/** Auth runs before the body is read, so unauthenticated callers never see body validation. */
export async function handleRevokeGrantRequest(
  req: Request,
  dependencies: RevokeGrantRequestDependencies,
): Promise<Response> {
  const collectionId = collectionIdFromPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return badRequest();
  }

  const access = await dependencies.requireOwnedLiveCollection(req, collectionId);
  const early = accessResponse(access);
  if (early) {
    return early;
  }
  if (access.kind !== 'ok') {
    return notFound();
  }

  const raw = await readBoundedText(req, BODY_LIMIT);
  if (raw === null) {
    return badRequest();
  }
  let body: unknown;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return badRequest();
  }
  const sub =
    body && typeof body === 'object'
      ? (body as { sub?: unknown }).sub
      : undefined;
  if (!isSafeFirestoreDocumentId(sub)) {
    return badRequest();
  }

  try {
    const outcome = await dependencies.revoke(access.sub, collectionId, sub);
    return revokeGrantHttpResponse(outcome);
  } catch (err) {
    console.error('collectionGrantsRevokePost store error:', err);
    return storeUnavailable();
  }
}

async function revokeGrantInFirestore(
  ownerSub: string,
  collectionId: string,
  viewerSub: string,
): Promise<RevokeGrantOutcome> {
  return orchestrateGrantRevoke(viewerSub, Date.now(), {
    runTransaction: async (work) => {
      const db = getStoreFirestore();
      return db.runTransaction(async (tx) => {
        const grantRef = grantColRef(ownerSub, collectionId).doc(viewerSub);
        return work({
          readForwardGrant: async (expectedViewerSub) => {
            const snap = await tx.get(grantRef);
            return parseGrantDoc(
              snap.exists ? snap.data() : undefined,
              expectedViewerSub,
            );
          },
          writePair: async (expectedViewerSub, tombstone) => {
            const shareRef = incomingShareRef(
              expectedViewerSub,
              shareGrantId(ownerSub, collectionId),
            );
            tx.set(grantRef, tombstone, { merge: false });
            tx.set(
              shareRef,
              incomingSharePayload(
                ownerSub,
                collectionId,
                tombstone.updatedAt,
                { deletedAt: tombstone.deletedAt },
              ),
              { merge: false },
            );
          },
        });
      });
    },
  });
}

export async function collectionGrantsRevokePost(req: Request): Promise<Response> {
  return handleRevokeGrantRequest(req, {
    requireOwnedLiveCollection,
    revoke: revokeGrantInFirestore,
  });
}

