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
  orchestrateGrantRoleChange,
  parseGrantDoc,
  parseIncomingShareDoc,
  shareGrantId,
  type GrantRoleOutcome,
  type LiveGrant,
  type RevokeGrantOutcome,
} from './grants.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
} from './membership.ts';
import { requestedShareRole, type ShareRole } from './shareAuth.ts';
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

function notFound(): Response {
  return jsonResponse({ error: 'Not found' }, 404);
}

type GrantJson = { sub: string; email: string; role: ShareRole; createdAt: number };

function grantJson(grant: LiveGrant): GrantJson {
  return {
    sub: grant.viewerSub,
    email: grant.email,
    role: grant.role,
    createdAt: grant.createdAt,
  };
}

export function revokeGrantHttpResponse(
  outcome: RevokeGrantOutcome,
): Response {
  if (outcome.kind === 'badRequest') {
    return jsonResponse({ error: 'Bad request' }, 400);
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
    /^\/api\/collections\/([^/]+)\/grants(?:\/revoke|\/role)?$/,
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
    const grants: GrantJson[] = [];
    for (const doc of snap.docs) {
      const parsed = parseGrantDoc(doc.data(), doc.id);
      if (!isLiveGrant(parsed)) {
        continue;
      }
      grants.push(grantJson(parsed));
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
  const record =
    body && typeof body === 'object' ? (body as { email?: unknown; role?: unknown }) : {};
  const email = normalizeShareEmail(record.email);
  const role = requestedShareRole(record.role);
  if (email === undefined || role === null) {
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
    const outcome = await commitCollectionGrant({
      ownerSub: access.sub,
      ownerEmail: access.email,
      collectionId,
      viewerSub: target.sub,
      email: target.email.trim().toLowerCase(),
      role,
      // The owner chose this role for this person; an existing grant takes it.
      onExisting: 'applyRole',
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
    return jsonResponse({ grant: grantJson(outcome.doc) });
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
    return jsonResponse({ error: 'Bad request' }, 400);
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
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  let body: unknown;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const sub =
    body && typeof body === 'object'
      ? (body as { sub?: unknown }).sub
      : undefined;
  if (!isSafeFirestoreDocumentId(sub)) {
    return jsonResponse({ error: 'Bad request' }, 400);
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

export function grantRoleHttpResponse(outcome: GrantRoleOutcome): Response {
  if (outcome.kind === 'badRequest') {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  if (outcome.kind === 'missing') {
    return notFound();
  }
  return jsonResponse({ grant: grantJson(outcome.doc) });
}

export type GrantRoleRequestDependencies = {
  requireOwnedLiveCollection: RevokeGrantRequestDependencies['requireOwnedLiveCollection'];
  changeRole: (
    ownerSub: string,
    collectionId: string,
    viewerSub: string,
    role: ShareRole,
  ) => Promise<GrantRoleOutcome>;
};

/**
 * `POST /api/collections/:id/grants/role` with `{ sub, role }`. Same order as
 * revoke: the collection owner is established before the body is read, so a
 * non-owner gets 404 whatever they send.
 */
export async function handleGrantRoleRequest(
  req: Request,
  dependencies: GrantRoleRequestDependencies,
): Promise<Response> {
  const collectionId = collectionIdFromPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
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
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  let body: unknown;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }
  const record =
    body && typeof body === 'object' ? (body as { sub?: unknown; role?: unknown }) : {};
  // Unlike grant creation, a role change must name the role.
  const role = record.role === undefined ? null : requestedShareRole(record.role);
  if (!isSafeFirestoreDocumentId(record.sub) || role === null) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  try {
    const outcome = await dependencies.changeRole(
      access.sub,
      collectionId,
      record.sub,
      role,
    );
    return grantRoleHttpResponse(outcome);
  } catch (err) {
    console.error('collectionGrantsRolePost store error:', err);
    return storeUnavailable();
  }
}

async function changeGrantRoleInFirestore(
  ownerSub: string,
  collectionId: string,
  viewerSub: string,
  role: ShareRole,
): Promise<GrantRoleOutcome> {
  return orchestrateGrantRoleChange(
    { ownerSub, collectionId, viewerSub, role },
    Date.now(),
    {
      runTransaction: async (work) => {
        const db = getStoreFirestore();
        return db.runTransaction(async (tx) => {
          const grantRef = grantColRef(ownerSub, collectionId).doc(viewerSub);
          const shareRef = incomingShareRef(
            viewerSub,
            shareGrantId(ownerSub, collectionId),
          );
          return work({
            readForwardGrant: async (expectedViewerSub) => {
              const snap = await tx.get(grantRef);
              return parseGrantDoc(
                snap.exists ? snap.data() : undefined,
                expectedViewerSub,
              );
            },
            readReverseShare: async () => {
              const snap = await tx.get(shareRef);
              return parseIncomingShareDoc(snap.exists ? snap.data() : undefined);
            },
            writePair: async (grant, share) => {
              tx.set(grantRef, grant, { merge: false });
              tx.set(shareRef, share, { merge: false });
            },
          });
        });
      },
    },
  );
}

export async function collectionGrantsRolePost(req: Request): Promise<Response> {
  return handleGrantRoleRequest(req, {
    requireOwnedLiveCollection,
    changeRole: changeGrantRoleInFirestore,
  });
}
