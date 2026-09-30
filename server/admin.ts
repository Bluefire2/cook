import {
  applyDecision,
  isValidSubParam,
  listAccessRequests,
  type AccessRequestLists,
  type AccessRequestRecord,
  type DecisionAction,
} from './members.ts';
import { mailFrom, publicOrigin } from './env.ts';
import { approvalRecipientProblem, isResendSandboxSender, sendMail } from './mail.ts';
import {
  INVITE_UNUSED_CAP,
  listUnusedInvites,
  MEMBER_INVITE_LIMIT,
  mintInvite,
  mintMemberInvite,
  revokeInvite,
  type InviteRecord,
} from './invites.ts';
import {
  clearMembershipCache,
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
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
  creatorEmail?: string;
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

function errorJson(code: string, error: string, status: number, max?: number): Response {
  const body: { error: string; code: string; max?: number } = { error, code };
  if (max !== undefined) {
    body.max = max;
  }
  return jsonResponse(body, status);
}

function adminForbidden(): Response {
  return errorJson('forbidden', 'Forbidden', 403);
}

function unsupportedMedia(): Response {
  return errorJson('unsupported-media', 'Unsupported Media Type', 415);
}

function payloadTooLarge(): Response {
  return errorJson('payload-too-large', 'Payload too large', 413);
}

function badRequest(): Response {
  return errorJson('bad-request', 'Bad request', 400);
}

const SELF_ERROR = "You can't change your own access.";
const UNKNOWN_REQUEST_ERROR = 'That access request was not found.';
const UNKNOWN_INVITE_ERROR = 'That invite link was not found.';
const MEMBER_INVITE_CAP_ERROR =
  'There are already too many unused invite links. Try again later.';
const MEMBER_INVITE_LIMIT_ERROR = `You have already invited ${MEMBER_INVITE_LIMIT} people.`;

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
  const entry: AdminInviteEntry = { id, createdAt: row.createdAt, expiresAt: row.expiresAt };
  if (row.createdByEmail !== undefined && row.createdByEmail !== '') {
    entry.creatorEmail = row.createdByEmail;
  }
  return entry;
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

// How long Approve waits on the approval email before answering. The send
// runs beside the list reread, so a healthy Resend adds nothing; a slow one
// is left to finish (or hit sendMail's own timeout) after the response.
const APPROVAL_MAIL_WAIT_MS = 3_000;

function sandboxSender(): boolean {
  try {
    return isResendSandboxSender(mailFrom());
  } catch {
    return false;
  }
}

async function notifyApproval(email: string): Promise<void> {
  const problem = approvalRecipientProblem(email);
  if (problem === 'missing') {
    console.log('approval email skipped: missing recipient');
    return;
  }
  if (problem === 'invalid') {
    console.log('approval email skipped: invalid recipient');
    return;
  }
  if (sandboxSender()) {
    console.log('approval email skipped: MAIL_FROM is the Resend sandbox sender');
    return;
  }

  const subject = 'Your Sous access was approved';
  let text: string;
  try {
    const origin = publicOrigin();
    text = `Your request for Sous was approved.\nSign in again at ${origin}`;
  } catch {
    text = 'Your request for Sous was approved.\nSign in again.';
  }

  try {
    await sendMail({ to: email, subject, text });
  } catch {
    console.log('approval email failed');
  }
}

function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
    return unsupportedMedia();
  }

  const text = await readBoundedText(req, 4096);
  if (text === null) {
    return payloadTooLarge();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest();
  }

  const body = parseDecisionBody(parsed);
  if (body === 'invalid') {
    return badRequest();
  }

  if (body.sub === owner.sub) {
    return errorJson('self', SELF_ERROR, 409);
  }

  try {
    const result = await applyDecision(body.sub, body.action, owner.sub, Date.now());
    if (result.kind === 'refusal') {
      if (result.reason === 'self') {
        return errorJson('self', SELF_ERROR, 409);
      }
      return errorJson('unknown-request', UNKNOWN_REQUEST_ERROR, 404);
    }
    const approvalMail =
      body.action === 'approve' && result.kind === 'ok'
        ? settleWithin(notifyApproval(result.request.email), APPROVAL_MAIL_WAIT_MS)
        : null;
    clearMembershipCache(body.sub);
    const lists = await listAccessRequests();
    if (approvalMail !== null) {
      await approvalMail;
    }
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
    const minted = await mintInvite(owner.sub, Date.now(), owner.email);
    if (minted.kind === 'cap') {
      return errorJson(
        'invite-cap',
        `There are already ${INVITE_UNUSED_CAP} unused invite links. Revoke one to mint another.`,
        409,
        INVITE_UNUSED_CAP,
      );
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

export async function memberInvitesPost(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }
  if (access.isOwner) {
    return adminForbidden();
  }

  try {
    const minted = await mintMemberInvite(access.sub, access.email, Date.now());
    if (minted.kind === 'cap') {
      return errorJson('member-invite-cap', MEMBER_INVITE_CAP_ERROR, 409);
    }
    if (minted.kind === 'limit') {
      return errorJson(
        'member-invite-limit',
        MEMBER_INVITE_LIMIT_ERROR,
        409,
        MEMBER_INVITE_LIMIT,
      );
    }
    return jsonResponse({ url: invitePublicUrl(minted.token) });
  } catch (err) {
    console.error('memberInvitesPost store error:', err);
    return storeUnavailable();
  }
}

export async function adminInviteRevokePost(req: Request): Promise<Response> {
  const owner = requireAdminOwner(req);
  if (owner.kind === 'response') {
    return owner.response;
  }

  if (!isJsonContentType(req)) {
    return unsupportedMedia();
  }

  const text = await readBoundedText(req, 4096);
  if (text === null) {
    return payloadTooLarge();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest();
  }

  const body = parseRevokeInviteBody(parsed);
  if (body === 'invalid') {
    return badRequest();
  }

  try {
    const result = await revokeInvite(body.id);
    if (result.kind === 'refusal') {
      return errorJson('unknown-invite', UNKNOWN_INVITE_ERROR, 404);
    }
    const rows = await listUnusedInvites(Date.now());
    return jsonResponse(serializeInviteList(rows));
  } catch (err) {
    console.error('adminInviteRevokePost store error:', err);
    return storeUnavailable();
  }
}
