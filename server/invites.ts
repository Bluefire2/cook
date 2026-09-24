import { createHash } from 'node:crypto';
import { FieldPath } from '@google-cloud/firestore';
import {
  inviteDeadPageHtml,
  inviteJoinPageHtml,
  unavailablePageHtml,
  type InviteDeadReason,
} from './access.ts';
import { isSecureOrigin } from './env.ts';
import {
  parseAccessRequestDoc,
  parseMemberDoc,
  type AccessRequestIdentity,
  type AccessRequestRecord,
} from './members.ts';
import {
  inviteCookie,
  isInviteId,
  randomToken,
  signInviteTx,
} from './session.ts';
import { getStoreFirestore } from './store.ts';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_UNUSED_CAP = 20;

export type InviteStatus = 'unused' | 'redeemed' | 'revoked';

export interface InviteRecord {
  status: InviteStatus;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  redeemedAt?: number;
  redeemedBy?: string;
}

export type InviteLandingVerdict =
  | { kind: 'join' }
  | { kind: 'dead'; reason: InviteDeadReason };

export type RedeemInviteTransitionResult =
  | {
      kind: 'ok';
      invite: InviteRecord;
      member: Record<string, unknown>;
      request: AccessRequestRecord;
    }
  | { kind: 'refusal'; reason: 'unknown' | 'expired' | 'used' | 'revoked' };

export type RevokeInviteTransitionResult =
  | { kind: 'ok'; invite: InviteRecord }
  | { kind: 'refusal'; reason: 'unknown' };

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isInviteTokenShape(raw: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(raw);
}

export function inviteTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/invite/')) {
    return null;
  }
  const rest = pathname.slice('/invite/'.length);
  if (rest === '' || rest.includes('/')) {
    return null;
  }
  return isInviteTokenShape(rest) ? rest : null;
}

export function parseInviteDoc(raw: unknown): InviteRecord | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (row.status !== 'unused' && row.status !== 'redeemed' && row.status !== 'revoked') {
    return null;
  }
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt) || row.createdAt <= 0) {
    return null;
  }
  if (typeof row.createdBy !== 'string' || row.createdBy === '') {
    return null;
  }
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= 0) {
    return null;
  }
  const record: InviteRecord = {
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
  };
  if (typeof row.redeemedAt === 'number' && Number.isFinite(row.redeemedAt)) {
    record.redeemedAt = row.redeemedAt;
  }
  if (typeof row.redeemedBy === 'string' && row.redeemedBy !== '') {
    record.redeemedBy = row.redeemedBy;
  }
  return record;
}

export function mintInviteRecord(createdBy: string, now: number): {
  token: string;
  id: string;
  record: InviteRecord;
} {
  const token = randomToken(32);
  return {
    token,
    id: hashInviteToken(token),
    record: {
      status: 'unused',
      createdAt: now,
      createdBy,
      expiresAt: now + INVITE_TTL_MS,
    },
  };
}

export function unusedUnexpired(rows: InviteRecord[], now: number): InviteRecord[] {
  return rows.filter((row) => row.status === 'unused' && row.expiresAt > now);
}

export function inviteLandingVerdict(
  invite: InviteRecord | null,
  now: number,
): InviteLandingVerdict {
  if (invite === null) {
    return { kind: 'dead', reason: 'unknown' };
  }
  if (invite.status === 'redeemed') {
    return { kind: 'dead', reason: 'used' };
  }
  if (invite.status === 'revoked') {
    return { kind: 'dead', reason: 'revoked' };
  }
  if (invite.expiresAt <= now) {
    return { kind: 'dead', reason: 'expired' };
  }
  if (invite.status !== 'unused') {
    return { kind: 'dead', reason: 'unknown' };
  }
  return { kind: 'join' };
}

export function redeemInviteTransition(
  invite: InviteRecord | null,
  identity: AccessRequestIdentity,
  existingRequest: AccessRequestRecord | null,
  now: number,
): RedeemInviteTransitionResult {
  if (invite === null) {
    return { kind: 'refusal', reason: 'unknown' };
  }
  if (invite.status === 'redeemed') {
    return { kind: 'refusal', reason: 'used' };
  }
  if (invite.status === 'revoked') {
    return { kind: 'refusal', reason: 'revoked' };
  }
  if (invite.expiresAt <= now) {
    return { kind: 'refusal', reason: 'expired' };
  }
  if (invite.status !== 'unused') {
    return { kind: 'refusal', reason: 'unknown' };
  }

  const request: AccessRequestRecord = existingRequest === null
    ? {
        sub: identity.sub,
        email: identity.email,
        status: 'approved',
        createdAt: now,
        updatedAt: now,
        requestCount: 0,
        decidedAt: now,
        decidedBy: invite.createdBy,
      }
    : {
        ...existingRequest,
        email: identity.email,
        status: 'approved',
        updatedAt: now,
        decidedAt: now,
        decidedBy: invite.createdBy,
      };
  if (identity.name !== undefined) {
    request.name = identity.name;
  }

  const member: Record<string, unknown> = {
    sub: identity.sub,
    email: identity.email,
    status: 'active',
    approvedAt: now,
    approvedBy: invite.createdBy,
    updatedAt: now,
  };
  if (identity.name !== undefined) {
    member.name = identity.name;
  }

  return {
    kind: 'ok',
    invite: {
      ...invite,
      status: 'redeemed',
      redeemedAt: now,
      redeemedBy: identity.sub,
    },
    member,
    request,
  };
}

export function revokeInviteTransition(
  invite: InviteRecord | null,
): RevokeInviteTransitionResult {
  if (invite === null || invite.status !== 'unused') {
    return { kind: 'refusal', reason: 'unknown' };
  }
  return { kind: 'ok', invite: { ...invite, status: 'revoked' } };
}

function invitesCollection() {
  return getStoreFirestore().collection('invites');
}

export async function readInvite(id: string): Promise<InviteRecord | null> {
  const snap = await invitesCollection().doc(id).get();
  if (!snap.exists) {
    return null;
  }
  return parseInviteDoc(snap.data());
}

export async function listUnusedInvites(now: number): Promise<{ id: string; record: InviteRecord }[]> {
  const snap = await invitesCollection()
    .where('status', '==', 'unused')
    .orderBy(FieldPath.documentId())
    .get();
  const rows: { id: string; record: InviteRecord }[] = [];
  for (const doc of snap.docs) {
    const parsed = parseInviteDoc(doc.data());
    if (parsed === null) {
      continue;
    }
    if (parsed.expiresAt <= now) {
      continue;
    }
    rows.push({ id: doc.id, record: parsed });
  }
  rows.sort((a, b) => b.record.createdAt - a.record.createdAt || a.id.localeCompare(b.id));
  return rows;
}

export async function mintInvite(
  createdBy: string,
  now: number,
): Promise<{ kind: 'ok'; token: string; id: string } | { kind: 'cap' }> {
  const unused = await listUnusedInvites(now);
  if (unused.length >= INVITE_UNUSED_CAP) {
    return { kind: 'cap' };
  }
  const minted = mintInviteRecord(createdBy, now);
  await invitesCollection().doc(minted.id).create(minted.record);
  return { kind: 'ok', token: minted.token, id: minted.id };
}

export async function revokeInvite(id: string): Promise<RevokeInviteTransitionResult> {
  if (!isInviteId(id)) {
    return { kind: 'refusal', reason: 'unknown' };
  }
  const ref = invitesCollection().doc(id);
  let result: RevokeInviteTransitionResult = { kind: 'refusal', reason: 'unknown' };
  await getStoreFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? parseInviteDoc(snap.data()) : null;
    const transition = revokeInviteTransition(existing);
    result = transition;
    if (transition.kind !== 'ok') {
      return;
    }
    tx.set(ref, transition.invite);
  });
  return result;
}

export async function redeemInvite(
  inviteId: string,
  identity: AccessRequestIdentity,
  now: number,
): Promise<RedeemInviteTransitionResult> {
  if (!isInviteId(inviteId)) {
    return { kind: 'refusal', reason: 'unknown' };
  }
  const inviteRef = invitesCollection().doc(inviteId);
  const memberRef = getStoreFirestore().collection('members').doc(identity.sub);
  const requestRef = getStoreFirestore().collection('accessRequests').doc(identity.sub);
  let result: RedeemInviteTransitionResult = { kind: 'refusal', reason: 'unknown' };

  await getStoreFirestore().runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    const requestSnap = await tx.get(requestRef);
    const memberSnap = await tx.get(memberRef);
    const invite = inviteSnap.exists ? parseInviteDoc(inviteSnap.data()) : null;
    const existingRequest = requestSnap.exists
      ? parseAccessRequestDoc(requestSnap.data(), identity.sub)
      : null;
    const existingMember = memberSnap.exists
      ? parseMemberDoc(memberSnap.data(), identity.sub)
      : null;
    if (existingMember !== null && existingMember.status === 'active') {
      result = { kind: 'refusal', reason: 'unknown' };
      return;
    }
    const transition = redeemInviteTransition(invite, identity, existingRequest, now);
    result = transition;
    if (transition.kind !== 'ok') {
      return;
    }
    tx.set(inviteRef, transition.invite);
    tx.set(memberRef, transition.member);
    tx.set(requestRef, transition.request);
  });

  return result;
}

function htmlResponse(
  body: string,
  status: number,
  extraCookies?: string[],
): Response {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  for (const cookie of extraCookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(body, { status, headers });
}

export async function inviteLandingGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = inviteTokenFromPath(url.pathname);
  if (token === null) {
    return htmlResponse(inviteDeadPageHtml('malformed'), 404);
  }

  try {
    const invite = await readInvite(hashInviteToken(token));
    const verdict = inviteLandingVerdict(invite, Date.now());
    if (verdict.kind === 'dead') {
      return htmlResponse(inviteDeadPageHtml(verdict.reason), 404);
    }

    const now = Date.now();
    const secure = isSecureOrigin();
    let cookie: string;
    try {
      cookie = inviteCookie(signInviteTx({ id: hashInviteToken(token) }, now), { secure });
    } catch (err) {
      console.error('signInviteTx failed:', err);
      return htmlResponse(unavailablePageHtml(), 503);
    }
    return htmlResponse(inviteJoinPageHtml(), 200, [cookie]);
  } catch (err) {
    console.error('inviteLandingGet store error:', err);
    return htmlResponse(unavailablePageHtml(), 503);
  }
}
