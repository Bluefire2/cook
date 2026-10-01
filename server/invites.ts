import { createHash } from 'node:crypto';
import { FieldPath } from '@google-cloud/firestore';
import {
  inviteDeadPageHtml,
  inviteJoinPageHtml,
  unavailablePageHtml,
  type InviteDeadReason,
} from './access.ts';
import { isAllowed } from './allowlist.ts';
import { allowedEmails, isSecureOrigin } from './env.ts';
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
/** Lifetime redeemed invites per member. Keep `settings.inviteIntro` in sync. */
export const MEMBER_INVITE_LIMIT = 5;

export type InviteStatus = 'unused' | 'redeemed' | 'revoked';

export interface InviteRecord {
  status: InviteStatus;
  createdAt: number;
  createdBy: string;
  createdByEmail?: string;
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
  | { kind: 'refusal'; reason: 'unknown' | 'expired' | 'used' | 'revoked' | 'limit' };

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
  if (typeof row.createdByEmail === 'string' && row.createdByEmail !== '') {
    record.createdByEmail = row.createdByEmail;
  }
  if (typeof row.redeemedAt === 'number' && Number.isFinite(row.redeemedAt)) {
    record.redeemedAt = row.redeemedAt;
  }
  if (typeof row.redeemedBy === 'string' && row.redeemedBy !== '') {
    record.redeemedBy = row.redeemedBy;
  }
  return record;
}

export function mintInviteRecord(
  createdBy: string,
  now: number,
  createdByEmail?: string,
): {
  token: string;
  id: string;
  record: InviteRecord;
} {
  const token = randomToken(32);
  const record: InviteRecord = {
    status: 'unused',
    createdAt: now,
    createdBy,
    expiresAt: now + INVITE_TTL_MS,
  };
  if (createdByEmail !== undefined && createdByEmail !== '') {
    record.createdByEmail = createdByEmail;
  }
  return {
    token,
    id: hashInviteToken(token),
    record,
  };
}

/**
 * A member may hold one unused link. When other people's unused links already
 * fill the cap, refuse and leave the caller's link in place.
 */
export function memberMintRevokeIds(
  unused: { id: string; record: InviteRecord }[],
  createdBy: string,
): { kind: 'cap' } | { kind: 'ok'; revokeIds: string[] } {
  const revokeIds = unused
    .filter((row) => row.record.createdBy === createdBy)
    .map((row) => row.id);
  const others = unused.length - revokeIds.length;
  if (others >= INVITE_UNUSED_CAP) {
    return { kind: 'cap' };
  }
  return { kind: 'ok', revokeIds };
}

export function countRedeemedInvites(rows: InviteRecord[], createdBy: string): number {
  return rows.filter((row) => row.createdBy === createdBy && row.status === 'redeemed').length;
}

export type MemberMintPlan =
  | { kind: 'limit' }
  | { kind: 'cap' }
  | { kind: 'ok'; revokeIds: string[] };

/**
 * A member may redeem `MEMBER_INVITE_LIMIT` links in total. Replaced, revoked,
 * and expired rows do not count. At the limit, the current unused link stays.
 */
export function planMemberMint(input: {
  creatorInvites: InviteRecord[];
  unused: { id: string; record: InviteRecord }[];
  createdBy: string;
}): MemberMintPlan {
  if (countRedeemedInvites(input.creatorInvites, input.createdBy) >= MEMBER_INVITE_LIMIT) {
    return { kind: 'limit' };
  }
  return memberMintRevokeIds(input.unused, input.createdBy);
}

export function redeemCreatorDecision(input: {
  createdByEmail?: string;
  creatorEmailAllowed: boolean;
  creatorMemberStatus: 'active' | 'revoked' | null;
  redeemedCount: number;
}): { kind: 'ok' } | { kind: 'refusal'; reason: 'revoked' | 'limit' } {
  const email = input.createdByEmail;
  const ownerMinted = email === undefined || email === '' || input.creatorEmailAllowed;
  if (ownerMinted) {
    return { kind: 'ok' };
  }
  if (input.creatorMemberStatus !== 'active') {
    return { kind: 'refusal', reason: 'revoked' };
  }
  if (input.redeemedCount >= MEMBER_INVITE_LIMIT) {
    return { kind: 'refusal', reason: 'limit' };
  }
  return { kind: 'ok' };
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

/**
 * Landing-page only. Redeem still checks the same decision inside its
 * transaction. `null` means the join page may be shown.
 */
export async function readInviteCreatorRefusal(
  invite: InviteRecord,
): Promise<'revoked' | 'limit' | null> {
  const creatorEmail = invite.createdByEmail;
  const creatorEmailAllowed =
    creatorEmail !== undefined &&
    creatorEmail !== '' &&
    isAllowed(creatorEmail, true, allowedEmails());
  if (creatorEmail === undefined || creatorEmail === '' || creatorEmailAllowed) {
    return null;
  }
  const creatorRef = getStoreFirestore().collection('members').doc(invite.createdBy);
  const [creatorSnap, createdSnap] = await Promise.all([
    creatorRef.get(),
    invitesCollection().where('createdBy', '==', invite.createdBy).get(),
  ]);
  const creator = creatorSnap.exists
    ? parseMemberDoc(creatorSnap.data(), invite.createdBy)
    : null;
  const decision = redeemCreatorDecision({
    createdByEmail: creatorEmail,
    creatorEmailAllowed: false,
    creatorMemberStatus: creator === null ? null : creator.status,
    redeemedCount: countRedeemedInvites(parsedInviteRows(createdSnap.docs), invite.createdBy),
  });
  return decision.kind === 'ok' ? null : decision.reason;
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
  createdByEmail?: string,
): Promise<{ kind: 'ok'; token: string; id: string } | { kind: 'cap' }> {
  const unused = await listUnusedInvites(now);
  if (unused.length >= INVITE_UNUSED_CAP) {
    return { kind: 'cap' };
  }
  const minted = mintInviteRecord(createdBy, now, createdByEmail);
  await invitesCollection().doc(minted.id).create(minted.record);
  return { kind: 'ok', token: minted.token, id: minted.id };
}

function parsedInviteRows(
  docs: { data: () => unknown }[],
): InviteRecord[] {
  const rows: InviteRecord[] = [];
  for (const doc of docs) {
    const parsed = parseInviteDoc(doc.data());
    if (parsed !== null) {
      rows.push(parsed);
    }
  }
  return rows;
}

export async function mintMemberInvite(
  createdBy: string,
  createdByEmail: string,
  now: number,
): Promise<{ kind: 'ok'; token: string; id: string } | { kind: 'cap' } | { kind: 'limit' }> {
  const invites = invitesCollection();
  let outcome: { kind: 'ok'; token: string; id: string } | { kind: 'cap' } | { kind: 'limit' } = {
    kind: 'cap',
  };
  await getStoreFirestore().runTransaction(async (tx) => {
    const mineSnap = await tx.get(invites.where('createdBy', '==', createdBy));
    const unusedSnap = await tx.get(invites.where('status', '==', 'unused'));
    const unused: { id: string; record: InviteRecord }[] = [];
    for (const doc of unusedSnap.docs) {
      const parsed = parseInviteDoc(doc.data());
      if (parsed !== null && parsed.expiresAt > now) {
        unused.push({ id: doc.id, record: parsed });
      }
    }
    const plan = planMemberMint({
      creatorInvites: parsedInviteRows(mineSnap.docs),
      unused,
      createdBy,
    });
    if (plan.kind !== 'ok') {
      outcome = plan;
      return;
    }
    const revokeIds = new Set(plan.revokeIds);
    for (const doc of unusedSnap.docs) {
      if (revokeIds.has(doc.id)) {
        tx.update(doc.ref, { status: 'revoked' });
      }
    }
    const minted = mintInviteRecord(createdBy, now, createdByEmail);
    tx.create(invites.doc(minted.id), minted.record);
    outcome = { kind: 'ok', token: minted.token, id: minted.id };
  });
  return outcome;
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
    if (transition.kind !== 'ok' || invite === null) {
      return;
    }
    const creatorEmail = invite.createdByEmail;
    const creatorIsOwner =
      creatorEmail === undefined ||
      creatorEmail === '' ||
      isAllowed(creatorEmail, true, allowedEmails());
    if (!creatorIsOwner) {
      const creatorRef = getStoreFirestore().collection('members').doc(invite.createdBy);
      const creatorSnap = await tx.get(creatorRef);
      const creator = creatorSnap.exists
        ? parseMemberDoc(creatorSnap.data(), invite.createdBy)
        : null;
      const createdSnap = await tx.get(invitesCollection().where('createdBy', '==', invite.createdBy));
      const decision = redeemCreatorDecision({
        createdByEmail: creatorEmail,
        creatorEmailAllowed: false,
        creatorMemberStatus: creator === null ? null : creator.status,
        redeemedCount: countRedeemedInvites(parsedInviteRows(createdSnap.docs), invite.createdBy),
      });
      if (decision.kind !== 'ok') {
        result = decision;
        return;
      }
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
    // Every page here is served at `/invite/<token>`. Without this, its links
    // (Sign in, Privacy) send that URL as `Referer`, which the request log
    // keeps. These pages only link and never POST, so `Origin: null` is moot.
    'Referrer-Policy': 'no-referrer',
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
    if (verdict.kind === 'dead' || invite === null) {
      return htmlResponse(inviteDeadPageHtml(verdict.kind === 'dead' ? verdict.reason : 'unknown'), 404);
    }
    const creatorRefusal = await readInviteCreatorRefusal(invite);
    if (creatorRefusal !== null) {
      return htmlResponse(inviteDeadPageHtml('revoked'), 404);
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
