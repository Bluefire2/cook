import { FieldPath } from '@google-cloud/firestore';
import { isAllowed } from './allowlist.ts';
import { allowedEmails } from './env.ts';
import { readMember } from './members.ts';
import { canViewPhoto } from './shareAuth.ts';
import {
  collectionDocRef,
  getStoreFirestore,
  isLiveDoc,
  isUuid,
  type StoreKind,
} from './store.ts';

export const MAX_LIVE_GRANTS = 20;
export const NO_ACCOUNT_MESSAGE = 'No Sous account with that email';

export type LiveGrant = {
  viewerSub: string;
  email: string;
  collectionId: string;
  createdAt: number;
  updatedAt: number;
};

export type GrantTombstone = {
  viewerSub: string;
  updatedAt: number;
  deletedAt: number;
};

export type IncomingShareDoc = {
  ownerSub: string;
  collectionId: string;
  ownerEmail?: string;
  updatedAt: number;
  deletedAt?: number;
};

export type LiveIncomingShare = {
  grantId: string;
  ownerSub: string;
  collectionId: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeShareEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const email = raw.trim().toLowerCase();
  if (email === '' || !email.includes('@') || email.length > 320) {
    return undefined;
  }
  return email;
}

export function shareGrantId(ownerSub: string, collectionId: string): string {
  return `${ownerSub}_${collectionId}`;
}

export function parseGrantDoc(
  raw: unknown,
  expectedViewerSub: string,
): LiveGrant | GrantTombstone | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.viewerSub !== 'string' || raw.viewerSub !== expectedViewerSub) {
    return null;
  }
  const updatedAt = finiteNumber(raw.updatedAt);
  if (updatedAt === undefined) {
    return null;
  }
  const deletedAt = finiteNumber(raw.deletedAt);
  if (deletedAt !== undefined) {
    return { viewerSub: raw.viewerSub, updatedAt, deletedAt };
  }
  if (typeof raw.email !== 'string' || raw.email === '') {
    return null;
  }
  if (typeof raw.collectionId !== 'string' || !isUuid(raw.collectionId)) {
    return null;
  }
  const createdAt = finiteNumber(raw.createdAt);
  if (createdAt === undefined) {
    return null;
  }
  return {
    viewerSub: raw.viewerSub,
    email: raw.email,
    collectionId: raw.collectionId,
    createdAt,
    updatedAt,
  };
}

export function isLiveGrant(
  grant: LiveGrant | GrantTombstone | null,
): grant is LiveGrant {
  return grant !== null && !('deletedAt' in grant);
}

export function addGrantTransition(input: {
  existing: LiveGrant | GrantTombstone | null;
  viewerSub: string;
  email: string;
  collectionId: string;
  now: number;
  liveCount: number;
}):
  | { kind: 'write'; doc: LiveGrant }
  | { kind: 'idempotent'; doc: LiveGrant }
  | { kind: 'cap' } {
  if (isLiveGrant(input.existing)) {
    return { kind: 'idempotent', doc: input.existing };
  }
  if (input.liveCount >= MAX_LIVE_GRANTS) {
    return { kind: 'cap' };
  }
  return {
    kind: 'write',
    doc: {
      viewerSub: input.viewerSub,
      email: input.email,
      collectionId: input.collectionId,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

export function revokeGrantTransition(input: {
  existing: LiveGrant | GrantTombstone | null;
  viewerSub: string;
  now: number;
}): { kind: 'write'; doc: GrantTombstone } | { kind: 'already'; doc: GrantTombstone } {
  if (input.existing !== null && 'deletedAt' in input.existing) {
    return { kind: 'already', doc: input.existing };
  }
  return {
    kind: 'write',
    doc: {
      viewerSub: input.viewerSub,
      updatedAt: input.now,
      deletedAt: input.now,
    },
  };
}

export function collectionLiveForGrant(
  txRead: Record<string, unknown> | undefined,
): boolean {
  return isLiveDoc(txRead);
}

export function incomingShareCascadeDoc(
  existing: IncomingShareDoc | undefined,
  ownerSub: string,
  collectionId: string,
  cascadeAt: number,
): IncomingShareDoc | null {
  if (existing !== undefined && existing.updatedAt > cascadeAt) {
    return null;
  }
  return incomingSharePayload(ownerSub, collectionId, cascadeAt, { deletedAt: cascadeAt });
}

export function grantCascadeRevoke(
  existing: LiveGrant | GrantTombstone | null,
  viewerSub: string,
  cascadeAt: number,
): GrantTombstone | null {
  if (existing !== null && existing.updatedAt > cascadeAt) {
    return null;
  }
  return {
    viewerSub,
    updatedAt: cascadeAt,
    deletedAt: cascadeAt,
  };
}

export function parseIncomingShareDoc(raw: unknown): IncomingShareDoc | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  if (typeof raw.ownerSub !== 'string' || raw.ownerSub === '') {
    return undefined;
  }
  if (typeof raw.collectionId !== 'string' || !isUuid(raw.collectionId)) {
    return undefined;
  }
  const updatedAt = finiteNumber(raw.updatedAt);
  if (updatedAt === undefined) {
    return undefined;
  }
  const share: IncomingShareDoc = {
    ownerSub: raw.ownerSub,
    collectionId: raw.collectionId,
    updatedAt,
  };
  if (typeof raw.ownerEmail === 'string' && raw.ownerEmail !== '') {
    share.ownerEmail = raw.ownerEmail;
  }
  const deletedAt = finiteNumber(raw.deletedAt);
  if (deletedAt !== undefined) {
    share.deletedAt = deletedAt;
  }
  return share;
}

/** Both sides tombstone or both skip; never write one side alone. */
export function cascadeGrantPairTransition(input: {
  existingGrant: LiveGrant | GrantTombstone | null;
  existingShare: IncomingShareDoc | undefined;
  viewerSub: string;
  ownerSub: string;
  collectionId: string;
  cascadeAt: number;
}): { grant: GrantTombstone; share: IncomingShareDoc } | null {
  const grant = grantCascadeRevoke(
    input.existingGrant,
    input.viewerSub,
    input.cascadeAt,
  );
  const share = incomingShareCascadeDoc(
    input.existingShare,
    input.ownerSub,
    input.collectionId,
    input.cascadeAt,
  );
  if (grant === null || share === null) {
    return null;
  }
  return { grant, share };
}

export function incomingSharePayload(
  ownerSub: string,
  collectionId: string,
  updatedAt: number,
  extra?: { ownerEmail?: string; deletedAt?: number },
): IncomingShareDoc {
  const share: IncomingShareDoc = { ownerSub, collectionId, updatedAt };
  if (extra?.ownerEmail) {
    share.ownerEmail = extra.ownerEmail;
  }
  if (extra?.deletedAt !== undefined) {
    share.deletedAt = extra.deletedAt;
  }
  return share;
}

export type ShareTarget =
  | { kind: 'ok'; sub: string; email: string }
  | { kind: 'self' }
  | { kind: 'notFound' }
  | { kind: 'unknown' };

export type UserEmailRow = { sub: string; email: string; lastSeenAt: number };

export async function resolveShareTarget(input: {
  email: string;
  actorSub: string;
  actorEmail: string;
  queryUsersByEmail: (email: string) => Promise<UserEmailRow[]>;
  isOwnerEmail: (email: string) => boolean;
  readMemberStatus: (sub: string) => Promise<'active' | 'revoked' | null>;
}): Promise<ShareTarget> {
  if (input.email === input.actorEmail.trim().toLowerCase()) {
    return { kind: 'self' };
  }
  let rows: UserEmailRow[];
  try {
    rows = await input.queryUsersByEmail(input.email);
  } catch {
    return { kind: 'unknown' };
  }
  if (rows.length === 0) {
    return { kind: 'notFound' };
  }
  rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const picked = rows[0];
  if (picked.sub === input.actorSub) {
    return { kind: 'self' };
  }
  if (input.isOwnerEmail(picked.email)) {
    return { kind: 'ok', sub: picked.sub, email: picked.email };
  }
  try {
    const status = await input.readMemberStatus(picked.sub);
    if (status === 'active') {
      return { kind: 'ok', sub: picked.sub, email: picked.email };
    }
    return { kind: 'notFound' };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function queryUsersByEmail(email: string): Promise<UserEmailRow[]> {
  const snap = await getStoreFirestore()
    .collection('users')
    .where('email', '==', email)
    .get();
  const rows: UserEmailRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const storedEmail = typeof data.email === 'string' ? data.email : email;
    const lastSeenAt =
      typeof data.lastSeenAt === 'number' && Number.isFinite(data.lastSeenAt)
        ? data.lastSeenAt
        : 0;
    rows.push({ sub: doc.id, email: storedEmail, lastSeenAt });
  }
  return rows;
}

export async function lookupAdmittedSubByEmail(
  email: string,
  actor: { sub: string; email: string },
): Promise<ShareTarget> {
  return resolveShareTarget({
    email,
    actorSub: actor.sub,
    actorEmail: actor.email,
    queryUsersByEmail,
    isOwnerEmail: (candidate) => isAllowed(candidate, true, allowedEmails()),
    readMemberStatus: async (sub) => {
      const member = await readMember(sub);
      return member?.status ?? null;
    },
  });
}

export function grantColRef(ownerSub: string, collectionId: string) {
  return collectionDocRef(ownerSub, collectionId).collection('grants');
}

export function incomingShareRef(viewerSub: string, grantId: string) {
  return getStoreFirestore()
    .collection('incomingShares')
    .doc(viewerSub)
    .collection('items')
    .doc(grantId);
}

export function incomingSharesCol(viewerSub: string) {
  return getStoreFirestore()
    .collection('incomingShares')
    .doc(viewerSub)
    .collection('items');
}

export async function listLiveIncomingShares(
  viewerSub: string,
): Promise<LiveIncomingShare[]> {
  const snap = await incomingSharesCol(viewerSub)
    .orderBy(FieldPath.documentId())
    .get();
  const out: Array<{ grantId: string; ownerSub: string; collectionId: string }> =
    [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (!isLiveDoc(data)) {
      continue;
    }
    if (typeof data.ownerSub !== 'string' || data.ownerSub === '') {
      continue;
    }
    if (typeof data.collectionId !== 'string' || !isUuid(data.collectionId)) {
      continue;
    }
    out.push({
      grantId: doc.id,
      ownerSub: data.ownerSub,
      collectionId: data.collectionId,
    });
  }
  return out;
}

export async function readLiveIncomingShare(
  viewerSub: string,
  grantId: string,
): Promise<LiveIncomingShare | undefined> {
  const snap = await incomingShareRef(viewerSub, grantId).get();
  if (!snap.exists) {
    return undefined;
  }
  const share = parseIncomingShareDoc(snap.data());
  if (share === undefined || share.deletedAt !== undefined) {
    return undefined;
  }
  return {
    grantId,
    ownerSub: share.ownerSub,
    collectionId: share.collectionId,
  };
}

type ReadDocData = (
  uid: string,
  kind: StoreKind,
  id: string,
) => Promise<Record<string, unknown> | undefined>;

export type SessionCanViewOwnerPhotoInput = {
  viewerSub: string;
  ownerSub: string;
  photoId: string;
  listLiveIncomingShares: (viewerSub: string) => Promise<LiveIncomingShare[]>;
  readLiveIncomingShare: (
    viewerSub: string,
    grantId: string,
  ) => Promise<LiveIncomingShare | undefined>;
  readDocData: ReadDocData;
};

export async function sessionCanViewOwnerPhoto(
  input: SessionCanViewOwnerPhotoInput,
): Promise<boolean> {
  const shares = await input.listLiveIncomingShares(input.viewerSub);
  for (const share of shares) {
    if (share.ownerSub !== input.ownerSub) {
      continue;
    }
    const current = await input.readLiveIncomingShare(
      input.viewerSub,
      share.grantId,
    );
    if (
      current === undefined ||
      current.grantId !== share.grantId ||
      current.ownerSub !== share.ownerSub ||
      current.collectionId !== share.collectionId
    ) {
      continue;
    }
    const collection = await input.readDocData(
      input.ownerSub,
      'collections',
      share.collectionId,
    );
    if (collection === undefined || !isLiveDoc(collection)) {
      continue;
    }
    const ids = Array.isArray(collection.recipeIds) ? collection.recipeIds : [];
    const recipes: Record<string, unknown>[] = [];
    for (const recipeId of ids) {
      if (typeof recipeId !== 'string') {
        continue;
      }
      const recipe = await input.readDocData(
        input.ownerSub,
        'recipes',
        recipeId,
      );
      if (recipe) {
        recipes.push({ ...recipe, id: recipeId });
      }
    }
    if (
      canViewPhoto(
        input.photoId,
        {
          ownerSub: share.ownerSub,
          collectionId: share.collectionId,
          grantId: share.grantId,
        },
        collection,
        recipes,
      )
    ) {
      return true;
    }
  }
  return false;
}

export async function cascadeCollectionGrants(
  ownerSub: string,
  collectionId: string,
  at: number,
): Promise<void> {
  const snap = await grantColRef(ownerSub, collectionId).get();
  const db = getStoreFirestore();
  const grantId = shareGrantId(ownerSub, collectionId);
  for (const doc of snap.docs) {
    const viewerSub = doc.id;
    const grantRef = grantColRef(ownerSub, collectionId).doc(viewerSub);
    const shareRef = incomingShareRef(viewerSub, grantId);
    await db.runTransaction(async (tx) => {
      const grantSnap = await tx.get(grantRef);
      const shareSnap = await tx.get(shareRef);
      const existingGrant = parseGrantDoc(
        grantSnap.exists ? grantSnap.data() : undefined,
        viewerSub,
      );
      const existingShare = shareSnap.exists
        ? parseIncomingShareDoc(shareSnap.data())
        : undefined;
      const next = cascadeGrantPairTransition({
        existingGrant,
        existingShare,
        viewerSub,
        ownerSub,
        collectionId,
        cascadeAt: at,
      });
      if (next === null) {
        return;
      }
      tx.set(grantRef, next.grant, { merge: false });
      tx.set(shareRef, next.share, { merge: false });
    });
  }
}
