import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sessionSecret } from './env.ts';

export const SESSION_COOKIE_NAME = 'sous_session';
export const OAUTH_COOKIE_NAME = 'sous_oauth';
export const INVITE_COOKIE_NAME = 'sous_invite';

/**
 * Carries the same token as the cookie, for clients that cannot rely on the
 * browser attaching a `SameSite=Lax` cookie — today only the Chrome extension,
 * which reads the cookie itself and forwards it. Honoured by
 * `readHeaderSession` alone; every other route stays cookie-only.
 */
export const SESSION_HEADER_NAME = 'x-sous-session';

const SESSION_MAX_AGE_SEC = 90 * 24 * 60 * 60;
const OAUTH_MAX_AGE_SEC = 600;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

export interface OauthTxPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  invite?: string;
  iat: number;
  exp: number;
}

export interface InviteTxPayload {
  id: string;
  iat: number;
  exp: number;
}

export interface AccessRequestTxPayload {
  sub: string;
  email: string;
  name?: string;
  iat: number;
  exp: number;
}

export type ReadSessionResult =
  | { status: 'ok'; session: SessionPayload }
  | { status: 'absent' }
  | { status: 'unusable' };

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

/** Rejects non-alphabet characters that Node's base64url decoder would ignore. */
function decodeBase64urlStrict(part: string): Buffer | null {
  if (part === '' || /[^A-Za-z0-9_-]/.test(part)) {
    return null;
  }
  const buf = Buffer.from(part, 'base64url');
  if (buf.toString('base64url') !== part) {
    return null;
  }
  return buf;
}

function base64urlDecodeJson(tokenPart: string): unknown | null {
  const buf = decodeBase64urlStrict(tokenPart);
  if (!buf) {
    return null;
  }
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function hmacSign(payloadPart: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payloadPart).digest();
  return base64urlEncode(sig);
}

function hmacVerify(payloadPart: string, sigPart: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  const actual = decodeBase64urlStrict(sigPart);
  if (!actual || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function splitToken(token: string): { payload: string; signature: string } | null {
  if (typeof token !== 'string') {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot === -1) {
    return null;
  }
  if (token.indexOf('.', dot + 1) !== -1) {
    return null;
  }
  return { payload: token.slice(0, dot), signature: token.slice(dot + 1) };
}

export function signSession(
  user: { sub: string; email: string },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + NINETY_DAYS_MS;
  const payloadPart = base64urlEncode(
    JSON.stringify({ v: 1, sub: user.sub, email: user.email, iat, exp }),
  );
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifySession(token: string, now: number): SessionPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    sub?: unknown;
    email?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 1) {
    return null;
  }
  if (typeof row.sub !== 'string' || row.sub === '') {
    return null;
  }
  if (typeof row.email !== 'string') {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  return { sub: row.sub, email: row.email, iat: row.iat, exp: row.exp };
}

const INVITE_ID_RE = /^[a-f0-9]{64}$/;

export function isInviteId(raw: string): boolean {
  return INVITE_ID_RE.test(raw);
}

export function signOauthTx(
  tx: {
    state: string;
    nonce: string;
    verifier: string;
    returnTo: string;
    invite?: string;
  },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payload: Record<string, unknown> = {
    v: 'oauth',
    state: tx.state,
    nonce: tx.nonce,
    verifier: tx.verifier,
    returnTo: tx.returnTo,
    iat,
    exp,
  };
  if (tx.invite !== undefined) {
    if (!isInviteId(tx.invite)) {
      throw new Error('oauth invite id is not a sha256 hex digest');
    }
    payload.invite = tx.invite;
  }
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyOauthTx(token: string, now: number): OauthTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    state?: unknown;
    nonce?: unknown;
    verifier?: unknown;
    returnTo?: unknown;
    invite?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'oauth') {
    return null;
  }
  if (
    typeof row.state !== 'string' ||
    typeof row.nonce !== 'string' ||
    typeof row.verifier !== 'string' ||
    typeof row.returnTo !== 'string'
  ) {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  const out: OauthTxPayload = {
    state: row.state,
    nonce: row.nonce,
    verifier: row.verifier,
    returnTo: row.returnTo,
    iat: row.iat,
    exp: row.exp,
  };
  if (typeof row.invite === 'string' && isInviteId(row.invite)) {
    out.invite = row.invite;
  }
  return out;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) {
      continue;
    }
    return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedSessionCookie(options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function oauthCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${OAUTH_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${OAUTH_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedOauthCookie(options: { secure: boolean }): string {
  const parts = [
    `${OAUTH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function signInviteTx(tx: { id: string }, now: number): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  if (!isInviteId(tx.id)) {
    throw new Error('invite id is not a sha256 hex digest');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payloadPart = base64urlEncode(
    JSON.stringify({ v: 'invite', id: tx.id, iat, exp }),
  );
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyInviteTx(token: string, now: number): InviteTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    id?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'invite') {
    return null;
  }
  if (typeof row.id !== 'string' || !isInviteId(row.id)) {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  return { id: row.id, iat: row.iat, exp: row.exp };
}

export function inviteCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${INVITE_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${OAUTH_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedInviteCookie(options: { secure: boolean }): string {
  const parts = [
    `${INVITE_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Cryptographic validation only — not an authorization decision.
 * Call `requireMember` (cookie) or `requireHeaderMember` (header).
 * A null token is absent before the secret is consulted, so a missing
 * credential stays absent even when `SESSION_SECRET` is unset.
 */
function sessionFromToken(token: string | null): ReadSessionResult {
  if (token === null) {
    return { status: 'absent' };
  }
  const secret = sessionSecret();
  if (!secret) {
    return { status: 'unusable' };
  }
  const session = verifySession(token, Date.now());
  if (!session) {
    return { status: 'unusable' };
  }
  return { status: 'ok', session };
}

/** Cryptographic cookie validation only — not an authorization decision; call `requireMember`. */
export function readSession(req: Request): ReadSessionResult {
  return sessionFromToken(readCookie(req, SESSION_COOKIE_NAME));
}

export function signAccessRequestTx(
  identity: { sub: string; email: string; name?: string },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payload: Record<string, unknown> = {
    v: 'accessreq',
    sub: identity.sub,
    email: identity.email,
    iat,
    exp,
  };
  if (identity.name !== undefined) {
    payload.name = identity.name;
  }
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyAccessRequestTx(
  token: string,
  now: number,
): AccessRequestTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    sub?: unknown;
    email?: unknown;
    name?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'accessreq') {
    return null;
  }
  if (typeof row.sub !== 'string' || row.sub === '') {
    return null;
  }
  if (typeof row.email !== 'string' || row.email === '') {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  const out: AccessRequestTxPayload = {
    sub: row.sub,
    email: row.email,
    iat: row.iat,
    exp: row.exp,
  };
  if (typeof row.name === 'string' && row.name !== '') {
    out.name = row.name;
  }
  return out;
}

/**
 * Header only, with no cookie fallback: the extension always has the token in
 * hand, and a fallback would give this route two different auth stories.
 */
export function readHeaderSession(req: Request): ReadSessionResult {
  const raw = req.headers.get(SESSION_HEADER_NAME)?.trim();
  return sessionFromToken(raw === undefined || raw === '' ? null : raw);
}

export function sessionFromHeader(req: Request): SessionPayload | null {
  const result = readHeaderSession(req);
  if (result.status === 'ok') {
    return result.session;
  }
  return null;
}

export function shouldRefresh(session: SessionPayload, now: number): boolean {
  return now - session.iat > REFRESH_AFTER_MS;
}

const C0_OR_DEL_OR_BACKSLASH = /[\u0000-\u001F\u007F\\]/;
const ENCODED_BACKSLASH = /%5[cC]/;

export function safeReturnTo(raw: string | null | undefined, origin: string): string {
  if (raw === null || raw === undefined || raw === '') {
    return '/';
  }
  if (C0_OR_DEL_OR_BACKSLASH.test(raw) || ENCODED_BACKSLASH.test(raw)) {
    return '/';
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return '/';
  }
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return '/';
  }
  if (resolved.origin !== base.origin) {
    return '/';
  }
  if (!resolved.pathname.startsWith('/') || resolved.pathname.startsWith('//')) {
    return '/';
  }
  return `${resolved.pathname}${resolved.search}`;
}

export function randomToken(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes));
}
