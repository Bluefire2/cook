import { FieldPath } from '@google-cloud/firestore';
import { getStoreFirestore } from './store.ts';

export interface MemberRecord {
  sub: string;
  status: 'active' | 'revoked';
  approvedAt: number;
  approvedBy: string;
}

export interface AccessRequestIdentity {
  sub: string;
  email: string;
  name?: string;
}

export interface AccessRequestRecord {
  sub: string;
  email: string;
  name?: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  updatedAt: number;
  requestCount: number;
  lastNotifiedAt?: number;
  identitySeenAt?: number;
  decidedAt?: number;
  decidedBy?: string;
}

export type AccessRequestPage = {
  rows: AccessRequestRecord[];
  nextCursor: string | null;
};

export type AccessRequestLists = {
  pending: AccessRequestPage;
  approved: AccessRequestPage;
  denied: AccessRequestPage;
};

const DAY_MS = 86_400_000;
const NOTIFICATIONS_META_ID = 'notifications';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMemberDoc(raw: unknown, expectedSub: string): MemberRecord | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.sub !== 'string' || raw.sub === '' || raw.sub !== expectedSub) {
    return null;
  }
  if (raw.status !== 'active' && raw.status !== 'revoked') {
    return null;
  }
  if (typeof raw.approvedAt !== 'number' || !Number.isFinite(raw.approvedAt) || raw.approvedAt <= 0) {
    return null;
  }
  if (typeof raw.approvedBy !== 'string' || raw.approvedBy === '') {
    return null;
  }
  return {
    sub: raw.sub,
    status: raw.status,
    approvedAt: raw.approvedAt,
    approvedBy: raw.approvedBy,
  };
}

function parseAccessRequestDoc(raw: unknown, expectedSub: string): AccessRequestRecord | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.sub !== 'string' || raw.sub === '' || raw.sub !== expectedSub) {
    return null;
  }
  if (typeof raw.email !== 'string' || raw.email === '') {
    return null;
  }
  if (raw.status !== 'pending' && raw.status !== 'approved' && raw.status !== 'denied') {
    return null;
  }
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) {
    return null;
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null;
  }
  if (typeof raw.requestCount !== 'number' || !Number.isFinite(raw.requestCount)) {
    return null;
  }
  const record: AccessRequestRecord = {
    sub: raw.sub,
    email: raw.email,
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    requestCount: raw.requestCount,
  };
  if (typeof raw.name === 'string' && raw.name !== '') {
    record.name = raw.name;
  }
  if (typeof raw.lastNotifiedAt === 'number' && Number.isFinite(raw.lastNotifiedAt)) {
    record.lastNotifiedAt = raw.lastNotifiedAt;
  }
  if (typeof raw.identitySeenAt === 'number' && Number.isFinite(raw.identitySeenAt)) {
    record.identitySeenAt = raw.identitySeenAt;
  }
  if (typeof raw.decidedAt === 'number' && Number.isFinite(raw.decidedAt)) {
    record.decidedAt = raw.decidedAt;
  }
  if (typeof raw.decidedBy === 'string' && raw.decidedBy !== '') {
    record.decidedBy = raw.decidedBy;
  }
  return record;
}

export function isValidSubParam(raw: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(raw);
}

export function nextRequestState(
  existing: AccessRequestRecord | null,
  identity: AccessRequestIdentity,
  now: number,
): { write: boolean; notificationEligible: boolean; doc: AccessRequestRecord | null } {
  if (existing === null) {
    const doc: AccessRequestRecord = {
      sub: identity.sub,
      email: identity.email,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      requestCount: 1,
      lastNotifiedAt: now,
    };
    if (identity.name !== undefined) {
      doc.name = identity.name;
    }
    return { write: true, notificationEligible: true, doc };
  }

  if (existing.status === 'approved' || existing.status === 'denied') {
    return { write: false, notificationEligible: false, doc: null };
  }

  if (existing.status === 'pending') {
    const lastNotified = existing.lastNotifiedAt ?? 0;
    const windowOpen = now - lastNotified >= DAY_MS;
    const underCap = existing.requestCount < 5;
    if (windowOpen && underCap) {
      const doc: AccessRequestRecord = {
        ...existing,
        email: identity.email,
        updatedAt: now,
        requestCount: existing.requestCount + 1,
        lastNotifiedAt: now,
      };
      if (identity.name !== undefined) {
        doc.name = identity.name;
      }
      return { write: true, notificationEligible: true, doc };
    }
    return { write: false, notificationEligible: false, doc: null };
  }

  return { write: false, notificationEligible: false, doc: null };
}

function utcDayKey(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function nextNotificationCounter(
  counter: { day: string; count: number } | null,
  now: number,
): { counter: { day: string; count: number }; allowed: boolean } {
  const day = utcDayKey(now);
  if (counter === null || counter.day !== day) {
    return { counter: { day, count: 1 }, allowed: true };
  }
  if (counter.count >= 20) {
    return { counter, allowed: false };
  }
  return { counter: { day, count: counter.count + 1 }, allowed: true };
}

export type DecisionAction = 'approve' | 'deny' | 'revoke';

export type DecisionTransitionResult =
  | {
      kind: 'ok';
      request: AccessRequestRecord;
      member: Record<string, unknown> | null;
    }
  | { kind: 'refusal'; reason: 'unknown-request' | 'self' };

export function decisionTransition(
  existing: AccessRequestRecord | null,
  action: DecisionAction,
  ownerSub: string,
  now: number,
): DecisionTransitionResult {
  if (existing === null) {
    return { kind: 'refusal', reason: 'unknown-request' };
  }
  if (existing.sub === ownerSub) {
    return { kind: 'refusal', reason: 'self' };
  }

  if (action === 'approve') {
    if (existing.status !== 'pending' && existing.status !== 'denied') {
      return { kind: 'refusal', reason: 'unknown-request' };
    }
    const request: AccessRequestRecord = {
      ...existing,
      status: 'approved',
      updatedAt: now,
      decidedAt: now,
      decidedBy: ownerSub,
    };
    const member: Record<string, unknown> = {
      sub: existing.sub,
      email: existing.email,
      status: 'active',
      approvedAt: now,
      approvedBy: ownerSub,
      updatedAt: now,
    };
    if (existing.name !== undefined) {
      member.name = existing.name;
    }
    return { kind: 'ok', request, member };
  }

  if (action === 'deny') {
    if (existing.status !== 'pending') {
      return { kind: 'refusal', reason: 'unknown-request' };
    }
    const request: AccessRequestRecord = {
      ...existing,
      status: 'denied',
      updatedAt: now,
      decidedAt: now,
      decidedBy: ownerSub,
    };
    return { kind: 'ok', request, member: null };
  }

  if (action === 'revoke') {
    if (existing.status !== 'approved') {
      return { kind: 'refusal', reason: 'unknown-request' };
    }
    const request: AccessRequestRecord = {
      ...existing,
      status: 'denied',
      updatedAt: now,
      decidedAt: now,
      decidedBy: ownerSub,
    };
    const member: Record<string, unknown> = {
      sub: existing.sub,
      email: existing.email,
      status: 'revoked',
      approvedAt: existing.decidedAt ?? now,
      approvedBy: existing.decidedBy ?? ownerSub,
      updatedAt: now,
    };
    if (existing.name !== undefined) {
      member.name = existing.name;
    }
    return { kind: 'ok', request, member };
  }

  return { kind: 'refusal', reason: 'unknown-request' };
}

export async function readMember(sub: string): Promise<MemberRecord | null> {
  const snap = await getStoreFirestore().collection('members').doc(sub).get();
  if (!snap.exists) {
    return null;
  }
  const parsed = parseMemberDoc(snap.data(), sub);
  if (parsed === null) {
    console.log(`members/${sub}: rejected malformed member document`);
    return null;
  }
  return parsed;
}

function accessRequestsRef(sub: string) {
  return getStoreFirestore().collection('accessRequests').doc(sub);
}

function notificationsMetaRef() {
  return getStoreFirestore().collection('accessRequestMeta').doc(NOTIFICATIONS_META_ID);
}

export async function recordAccessRequest(
  identity: AccessRequestIdentity,
  now: number,
): Promise<{ outcome: 'recorded' | 'quiet' | 'already-approved'; notify: boolean }> {
  const ref = accessRequestsRef(identity.sub);
  const initialSnap = await ref.get();
  let existing: AccessRequestRecord | null = null;
  if (initialSnap.exists) {
    existing = parseAccessRequestDoc(initialSnap.data(), identity.sub);
  }

  if (existing !== null && existing.status === 'approved') {
    return { outcome: 'already-approved', notify: false };
  }

  const phase1 = nextRequestState(existing, identity, now);
  if (!phase1.write) {
    return { outcome: 'quiet', notify: false };
  }

  const result = {
    outcome: 'recorded' as 'recorded' | 'quiet' | 'already-approved',
    notify: false,
  };

  await getStoreFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let current: AccessRequestRecord | null = null;
    if (snap.exists) {
      current = parseAccessRequestDoc(snap.data(), identity.sub);
    }
    if (current !== null && current.status === 'approved') {
      result.outcome = 'already-approved';
      result.notify = false;
      return;
    }

    const state = nextRequestState(current, identity, now);
    if (!state.write || state.doc === null) {
      result.outcome = 'quiet';
      result.notify = false;
      return;
    }

    let deliveryAllowed = false;
    if (state.notificationEligible) {
      const metaSnap = await tx.get(notificationsMetaRef());
      let counter: { day: string; count: number } | null = null;
      if (metaSnap.exists) {
        const data = metaSnap.data();
        if (
          isPlainObject(data) &&
          typeof data.day === 'string' &&
          typeof data.count === 'number' &&
          Number.isFinite(data.count)
        ) {
          counter = { day: data.day, count: data.count };
        }
      }
      const next = nextNotificationCounter(counter, now);
      deliveryAllowed = next.allowed;
      if (next.allowed) {
        tx.set(notificationsMetaRef(), next.counter);
      }
    }

    tx.set(ref, state.doc);
    result.notify = state.notificationEligible && deliveryAllowed;
    result.outcome = 'recorded';
  });

  if (result.outcome === 'already-approved') {
    return { outcome: 'already-approved', notify: false };
  }
  return { outcome: result.outcome, notify: result.notify };
}

export async function touchRequestIdentity(
  sub: string,
  identity: AccessRequestIdentity,
): Promise<void> {
  const ref = accessRequestsRef(sub);
  const update: Record<string, unknown> = {
    email: identity.email,
    identitySeenAt: Date.now(),
  };
  if (identity.name !== undefined) {
    update.name = identity.name;
  }
  try {
    await ref.update(update);
  } catch (err: unknown) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 5 || code === 'NOT_FOUND') {
      return;
    }
    console.log(`touchRequestIdentity failed for ${sub}`);
  }
}

async function queryAccessRequestPage(
  status: AccessRequestRecord['status'],
  cursor: string | undefined,
): Promise<AccessRequestPage> {
  let query = getStoreFirestore()
    .collection('accessRequests')
    .where('status', '==', status)
    .orderBy(FieldPath.documentId())
    .limit(201);
  if (cursor !== undefined && cursor !== '') {
    query = query.startAfter(cursor);
  }
  const snap = await query.get();
  const rows: AccessRequestRecord[] = [];
  for (const doc of snap.docs) {
    const parsed = parseAccessRequestDoc(doc.data(), doc.id);
    if (parsed !== null) {
      rows.push(parsed);
    }
  }
  if (rows.length <= 200) {
    return { rows, nextCursor: null };
  }
  const page = rows.slice(0, 200);
  return { nextCursor: page[page.length - 1]!.sub, rows: page };
}

export async function listAccessRequests(cursors?: {
  pending?: string;
  approved?: string;
  denied?: string;
}): Promise<AccessRequestLists> {
  const [pending, approved, denied] = await Promise.all([
    queryAccessRequestPage('pending', cursors?.pending),
    queryAccessRequestPage('approved', cursors?.approved),
    queryAccessRequestPage('denied', cursors?.denied),
  ]);
  return { pending, approved, denied };
}

export async function applyDecision(
  sub: string,
  action: DecisionAction,
  ownerSub: string,
  now: number,
): Promise<DecisionTransitionResult> {
  const requestRef = accessRequestsRef(sub);
  const memberRef = getStoreFirestore().collection('members').doc(sub);

  let result: DecisionTransitionResult = { kind: 'refusal', reason: 'unknown-request' };

  await getStoreFirestore().runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef);
    // Revoke needs the existing member snapshot to keep approvedAt/approvedBy.
    // Firestore forbids reads after writes in a transaction, so this get must
    // happen before any set — even when the transition later refuses.
    const memSnap = action === 'revoke' ? await tx.get(memberRef) : null;
    let existing: AccessRequestRecord | null = null;
    if (reqSnap.exists) {
      existing = parseAccessRequestDoc(reqSnap.data(), sub);
    }
    const transition = decisionTransition(existing, action, ownerSub, now);
    result = transition;
    if (transition.kind !== 'ok') {
      return;
    }
    tx.set(requestRef, transition.request);
    if (transition.member !== null) {
      let memberBody = transition.member;
      if (memSnap?.exists) {
        const mem = parseMemberDoc(memSnap.data(), sub);
        if (mem !== null) {
          memberBody = {
            ...transition.member,
            approvedAt: mem.approvedAt,
            approvedBy: mem.approvedBy,
          };
        }
      }
      tx.set(memberRef, memberBody);
    }
  });

  return result;
}

/** Pure helper for tests: delivery notify when notificationEligible and counter allow. */
export function composeNotifyDecision(
  notificationEligible: boolean,
  counter: { day: string; count: number } | null,
  now: number,
): boolean {
  if (!notificationEligible) {
    return false;
  }
  return nextNotificationCounter(counter, now).allowed;
}
