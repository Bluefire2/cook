import { isAllowed } from './allowlist.ts';
import { allowedEmails } from './env.ts';
import { readMember, type MemberRecord } from './members.ts';
import { readSession } from './session.ts';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 500;

const activeMemberCache = new Map<string, number>();

export function clearMembershipCache(sub: string): void {
  activeMemberCache.delete(sub);
}

function trimCacheIfNeeded(): void {
  if (activeMemberCache.size > CACHE_MAX_SIZE) {
    activeMemberCache.clear();
  }
}

export function accessDecision(input: {
  email: string;
  emailVerified: boolean;
  allowedRaw: string;
  member: MemberRecord | null;
}): 'owner' | 'member' | 'denied' {
  if (isAllowed(input.email, input.emailVerified, input.allowedRaw)) {
    return 'owner';
  }
  if (input.emailVerified !== true) {
    return 'denied';
  }
  if (input.member !== null && input.member.status === 'active') {
    return 'member';
  }
  return 'denied';
}

async function readActiveMemberCached(sub: string, now: number): Promise<MemberRecord | null> {
  const cachedUntil = activeMemberCache.get(sub);
  if (cachedUntil !== undefined && now < cachedUntil) {
    return {
      sub,
      status: 'active',
      approvedAt: 1,
      approvedBy: 'cache',
    };
  }

  const member = await readMember(sub);
  if (member !== null && member.status === 'active') {
    activeMemberCache.set(sub, now + CACHE_TTL_MS);
    trimCacheIfNeeded();
    return member;
  }
  activeMemberCache.delete(sub);
  return member;
}

export async function accessAllows(identity: {
  sub: string;
  email: string;
  emailVerified: boolean;
}): Promise<'owner' | 'member' | 'denied' | 'unknown'> {
  try {
    const decision = accessDecision({
      email: identity.email,
      emailVerified: identity.emailVerified,
      allowedRaw: allowedEmails(),
      member: null,
    });
    if (decision === 'owner') {
      return 'owner';
    }
    if (identity.emailVerified !== true) {
      return 'denied';
    }
    const member = await readActiveMemberCached(identity.sub, Date.now());
    const finalDecision = accessDecision({
      email: identity.email,
      emailVerified: identity.emailVerified,
      allowedRaw: allowedEmails(),
      member,
    });
    if (finalDecision === 'member') {
      return 'member';
    }
    return 'denied';
  } catch {
    return 'unknown';
  }
}

export type RequireMemberResult =
  | { kind: 'ok'; sub: string; email: string; isOwner: boolean }
  | { kind: 'denied' }
  | { kind: 'unknown' };

export async function requireMember(req: Request): Promise<RequireMemberResult> {
  const sessionResult = readSession(req);
  if (sessionResult.status !== 'ok') {
    return { kind: 'denied' };
  }
  const { sub, email } = sessionResult.session;
  const allowedRaw = allowedEmails();
  const ownerCheck = accessDecision({
    email,
    emailVerified: true,
    allowedRaw,
    member: null,
  });
  if (ownerCheck === 'owner') {
    return { kind: 'ok', sub, email, isOwner: true };
  }

  try {
    const now = Date.now();
    const member = await readActiveMemberCached(sub, now);
    const decision = accessDecision({
      email,
      emailVerified: true,
      allowedRaw,
      member,
    });
    if (decision === 'member') {
      return { kind: 'ok', sub, email, isOwner: false };
    }
    return { kind: 'denied' };
  } catch {
    return { kind: 'unknown' };
  }
}

export type RequireOwnerResult =
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; sub: string; email: string };

export function requireOwner(req: Request): RequireOwnerResult {
  const sessionResult = readSession(req);
  if (sessionResult.status === 'absent') {
    return { kind: 'unauthenticated' };
  }
  if (sessionResult.status !== 'ok') {
    return { kind: 'unauthenticated' };
  }
  if (!isAllowed(sessionResult.session.email, true, allowedEmails())) {
    return { kind: 'forbidden' };
  }
  return {
    kind: 'ok',
    sub: sessionResult.session.sub,
    email: sessionResult.session.email,
  };
}

export function membershipUnauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export function membershipUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'Membership unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export function storeUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'Store unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function readBoundedText(req: Request, limit: number): Promise<string | null> {
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > limit) {
      return null;
    }
  }

  if (req.body === null) {
    return '';
  }

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }

  let combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(combined);
}

export type MembershipHandlerContext = { authorizedSub: string };

export function withMembership(
  handler: (req: Request, ctx: MembershipHandlerContext) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const access = await requireMember(req);
    if (access.kind === 'denied') {
      return membershipUnauthorized();
    }
    if (access.kind === 'unknown') {
      return membershipUnavailable();
    }
    return handler(req, { authorizedSub: access.sub });
  };
}

/** Test hook: membership cache lookup with injected clock. */
export async function lookupMemberForTest(
  sub: string,
  now: number,
): Promise<MemberRecord | null> {
  return readActiveMemberCached(sub, now);
}

export function cacheSizeForTest(): number {
  return activeMemberCache.size;
}
