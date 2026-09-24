import {
  applyDecision,
  isValidSubParam,
  listAccessRequests,
  type AccessRequestLists,
  type AccessRequestRecord,
  type DecisionAction,
} from './members.ts';
import { publicOrigin } from './env.ts';
import {
  listUnusedInvites,
  mintInvite,
  revokeInvite,
  type InviteRecord,
} from './invites.ts';
import {
  clearMembershipCache,
  membershipUnauthorized,
  readBoundedText,
  requireOwner,
  storeUnavailable,
} from './membership.ts';
import { isInviteId } from './session.ts';
export type AdminDecisionAction = DecisionAction;

export interface AdminAccessRequestEntry {
  sub: string;
  email: string;
  name?: string;
  requestedAt: number;
  decidedAt?: number;
  requestCount: number;
}

export interface AdminAccessRequestPage {
  rows: AdminAccessRequestEntry[];
  nextCursor: string | null;
}

export interface AdminAccessRequestLists {
  pending: AdminAccessRequestPage;
  approved: AdminAccessRequestPage;
  denied: AdminAccessRequestPage;
}

export interface AdminInviteEntry {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface AdminInviteList {
  invites: AdminInviteEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function adminForbidden(): Response {
  return jsonResponse({ error: 'Forbidden' }, 403);
}

export function parseAdminListCursors(params: URLSearchParams): {
  pending?: string;
  approved?: string;
  denied?: string;
} {
  const read = (key: string): string | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === '') {
      return undefined;
    }
    return isValidSubParam(raw) ? raw : undefined;
  };
  return {
    pending: read('afterPending'),
    approved: read('afterApproved'),
    denied: read('afterDenied'),
  };
}

export function toAdminAccessRequestEntry(row: AccessRequestRecord): AdminAccessRequestEntry {
  const entry: AdminAccessRequestEntry = {
    sub: row.sub,
    email: row.email,
    requestedAt: row.createdAt,
    requestCount: row.requestCount,
  };
  if (row.name !== undefined) {
    entry.name = row.name;
  }
  if (row.decidedAt !== undefined) {
    entry.decidedAt = row.decidedAt;
  }
  return entry;
}

export function serializeAccessRequestLists(lists: AccessRequestLists): AdminAccessRequestLists {
  const page = (section: AccessRequestLists['pending']): AdminAccessRequestPage => ({
    rows: section.rows.map(toAdminAccessRequestEntry),
    nextCursor: section.nextCursor,
  });
  return {
    pending: page(lists.pending),
    approved: page(lists.approved),
    denied: page(lists.denied),
  };
}

export function parseRevokeInviteBody(raw: unknown): { id: string } | 'invalid' {
  if (!isPlainObject(raw)) {
    return 'invalid';
  }
  if (typeof raw.id !== 'string' || !isInviteId(raw.id)) {
    return 'invalid';
  }
  return { id: raw.id };
}

export function toAdminInviteEntry(
  id: string,
  row: InviteRecord,
): AdminInviteEntry {
  return { id, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export function serializeInviteList(
  rows: { id: string; record: InviteRecord }[],
): AdminInviteList {
  return {
    invites: rows.map((row) => toAdminInviteEntry(row.id, row.record)),
  };
}

function invitePublicUrl(token: string): string {
  return `${publicOrigin()}/invite/${token}`;
}

export function parseDecisionBody(
  raw: unknown,
): { sub: string; action: AdminDecisionAction } | 'invalid' {
  if (!isPlainObject(raw)) {
    return 'invalid';
  }
  if (typeof raw.sub !== 'string' || !isValidSubParam(raw.sub)) {
    return 'invalid';
  }
  if (raw.action !== 'approve' && raw.action !== 'deny' && raw.action !== 'revoke') {
    return 'invalid';
  }
  return { sub: raw.sub, action: raw.action };
}

function isJsonContentType(req: Request): boolean {
  const header = req.headers.get('content-type');
  if (header === null) {
    return false;
  }
  const base = header.split(';')[0]?.trim().toLowerCase();
  return base === 'application/json';
}

export async function adminRequestsGet(req: Request): Promise<Response> {
  const owner = requireOwner(req);
  if (owner.kind === 'unauthenticated') {
    return membershipUnauthorized();
  }
  if (owner.kind === 'forbidden') {
    return adminForbidden();
  }

  try {
    const url = new URL(req.url);
    const cursors = parseAdminListCursors(url.searchParams);
    const lists = await listAccessRequests(cursors);
    return jsonResponse(serializeAccessRequestLists(lists));
  } catch (err) {
    console.error('adminRequestsGet store error:', err);
    return storeUnavailable();
  }
}

export async function adminDecisionPost(req: Request): Promise<Response> {
  const owner = requireOwner(req);
  if (owner.kind === 'unauthenticated') {
    return membershipUnauthorized();
  }
  if (owner.kind === 'forbidden') {
    return adminForbidden();
  }

  if (!isJsonContentType(req)) {
    return jsonResponse({ error: 'Unsupported Media Type' }, 415);
  }

  const text = await readBoundedText(req, 4096);
  if (text === null) {
    return jsonResponse({ error: 'Payload too large' }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  const body = parseDecisionBody(parsed);
  if (body === 'invalid') {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  if (body.sub === owner.sub) {
    return jsonResponse({ error: 'self' }, 409);
  }

  try {
    const result = await applyDecision(body.sub, body.action, owner.sub, Date.now());
    if (result.kind === 'refusal') {
      if (result.reason === 'self') {
        return jsonResponse({ error: 'self' }, 409);
      }
      return jsonResponse({ error: 'unknown-request' }, 404);
    }
    clearMembershipCache(body.sub);
    const lists = await listAccessRequests();
    return jsonResponse(serializeAccessRequestLists(lists));
  } catch (err) {
    console.error('adminDecisionPost store error:', err);
    return storeUnavailable();
  }
}

function requireAdminOwner(req: Request):
  | { kind: 'response'; response: Response }
  | { kind: 'ok'; sub: string; email: string } {
  const owner = requireOwner(req);
  if (owner.kind === 'unauthenticated') {
    return { kind: 'response', response: membershipUnauthorized() };
  }
  if (owner.kind === 'forbidden') {
    return { kind: 'response', response: adminForbidden() };
  }
  return owner;
}

export async function adminInvitesGet(req: Request): Promise<Response> {
  const owner = requireAdminOwner(req);
  if (owner.kind === 'response') {
    return owner.response;
  }

  try {
    const rows = await listUnusedInvites(Date.now());
    return jsonResponse(serializeInviteList(rows));
  } catch (err) {
    console.error('adminInvitesGet store error:', err);
    return storeUnavailable();
  }
}

export async function adminInvitesPost(req: Request): Promise<Response> {
  const owner = requireAdminOwner(req);
  if (owner.kind === 'response') {
    return owner.response;
  }

  try {
    const minted = await mintInvite(owner.sub, Date.now());
    if (minted.kind === 'cap') {
      return jsonResponse({ error: 'invite-cap' }, 409);
    }
    const rows = await listUnusedInvites(Date.now());
    return jsonResponse({
      url: invitePublicUrl(minted.token),
      ...serializeInviteList(rows),
    });
  } catch (err) {
    console.error('adminInvitesPost store error:', err);
    return storeUnavailable();
  }
}

export async function adminInviteRevokePost(req: Request): Promise<Response> {
  const owner = requireAdminOwner(req);
  if (owner.kind === 'response') {
    return owner.response;
  }

  if (!isJsonContentType(req)) {
    return jsonResponse({ error: 'Unsupported Media Type' }, 415);
  }

  const text = await readBoundedText(req, 4096);
  if (text === null) {
    return jsonResponse({ error: 'Payload too large' }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  const body = parseRevokeInviteBody(parsed);
  if (body === 'invalid') {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  try {
    const result = await revokeInvite(body.id);
    if (result.kind === 'refusal') {
      return jsonResponse({ error: 'unknown-invite' }, 404);
    }
    const rows = await listUnusedInvites(Date.now());
    return jsonResponse(serializeInviteList(rows));
  } catch (err) {
    console.error('adminInviteRevokePost store error:', err);
    return storeUnavailable();
  }
}
