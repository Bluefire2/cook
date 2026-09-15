import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { allowedEmails, sessionSecret } from './env.ts';
import { isAllowed } from './allowlist.ts';

export const SESSION_COOKIE_NAME = 'sous_session';
export const OAUTH_COOKIE_NAME = 'sous_oauth';

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

export function signOauthTx(
  tx: { state: string; nonce: string; verifier: string; returnTo: string },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payloadPart = base64urlEncode(
    JSON.stringify({
      v: 'oauth',
      state: tx.state,
      nonce: tx.nonce,
      verifier: tx.verifier,
      returnTo: tx.returnTo,
      iat,
      exp,
    }),
  );
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
  return {
    state: row.state,
    nonce: row.nonce,
    verifier: row.verifier,
    returnTo: row.returnTo,
    iat: row.iat,
    exp: row.exp,
  };
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

export function readSession(req: Request): ReadSessionResult {
  const token = readCookie(req, SESSION_COOKIE_NAME);
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
  if (!isAllowed(session.email, true, allowedEmails())) {
    return { status: 'unusable' };
  }
  return { status: 'ok', session };
}

export function sessionFrom(req: Request): SessionPayload | null {
  const result = readSession(req);
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
