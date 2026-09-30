import {
  collectionLinkConfirmPageHtml,
  collectionLinkDeadPageHtml,
  collectionLinkFullPageHtml,
  collectionLinkSignInPageHtml,
  invitationOnlyPage,
  unavailablePageHtml,
} from './access.ts';
import {
  COLLECTION_LINK_TTL_MS,
  collectionLinkIsLive,
  collectionLinkTokenFromPath,
  hashCollectionLinkToken,
  isCollectionLinkId,
  MAX_LIVE_COLLECTION_LINKS,
  listCollectionLinks,
  mintCollectionLink,
  readCollectionLink,
  redeemCollectionLink,
  revokeCollectionLink,
  type CollectionLinkEntry,
  type CollectionLinkRecord,
  type CollectionLinkRedeemOutcome,
} from './collectionLinks.ts';
import { isSecureOrigin, publicOrigin } from './env.ts';
import { sharingOwnerAdmitted } from './grants.ts';
import { accessResponse, errorJson, requireOwnedLiveCollection } from './grantsHttp.ts';
import {
  readBoundedText,
  storeUnavailable,
  visitorMembership,
  type VisitorMembership,
} from './membership.ts';
import {
  COLLECTION_LINK_COOKIE_NAME,
  clearedCollectionLinkCookie,
  collectionLinkCookie,
  readCookie,
  signAccessRequestTx,
  signCollectionLinkTx,
  verifyCollectionLinkTx,
} from './session.ts';
import { requestedShareRole, type ShareRole } from './shareAuth.ts';
import { isLiveDoc, isUuid, readDocData } from './store.ts';

const BODY_LIMIT = 2_000;

// ---------------------------------------------------------------------------
// Owner API: /api/collections/:id/links — collection owner, cookie session.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// Errors carry a stable `code` for the client catalog; `error` is the English
// fallback for older clients.
function badRequest(): Response {
  return errorJson('bad-request', 'Bad request', 400);
}

function notFound(): Response {
  return errorJson('not-found', 'Not found', 404);
}

export function linkCapResponse(): Response {
  return errorJson(
    'link-cap',
    `This collection already has ${MAX_LIVE_COLLECTION_LINKS} live links. Revoke one first.`,
    409,
    MAX_LIVE_COLLECTION_LINKS,
  );
}

export function collectionIdFromLinksPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/collections\/([^/]+)\/links(?:\/revoke)?$/);
  if (!match) {
    return null;
  }
  return isUuid(match[1]) ? match[1] : null;
}

export function collectionLinkUrl(origin: string, token: string): string {
  return `${origin}/c/${token}`;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedText(req, BODY_LIMIT);
  if (raw === null) {
    return null;
  }
  try {
    const body: unknown = raw === '' ? {} : JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type CollectionLinksApiDependencies = {
  requireOwnedLiveCollection: typeof requireOwnedLiveCollection;
  list: (ownerSub: string, collectionId: string, now: number) => Promise<CollectionLinkEntry[]>;
  mint: typeof mintCollectionLink;
  revoke: typeof revokeCollectionLink;
  origin: () => string;
  now: () => number;
};

const liveApiDependencies: CollectionLinksApiDependencies = {
  requireOwnedLiveCollection,
  list: listCollectionLinks,
  mint: mintCollectionLink,
  revoke: revokeCollectionLink,
  origin: publicOrigin,
  now: () => Date.now(),
};

/** Owner is established before any body is read, so anyone else gets 404 whatever they send. */
async function ownerGate(
  req: Request,
  deps: CollectionLinksApiDependencies,
): Promise<{ kind: 'ok'; sub: string; email: string; collectionId: string } | Response> {
  const collectionId = collectionIdFromLinksPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return badRequest();
  }
  const access = await deps.requireOwnedLiveCollection(req, collectionId);
  const early = accessResponse(access);
  if (early) {
    return early;
  }
  if (access.kind !== 'ok') {
    return notFound();
  }
  return { kind: 'ok', sub: access.sub, email: access.email, collectionId };
}

export async function handleCollectionLinksGet(
  req: Request,
  deps: CollectionLinksApiDependencies,
): Promise<Response> {
  const gate = await ownerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    return jsonResponse({ links: await deps.list(gate.sub, gate.collectionId, deps.now()) });
  } catch (err) {
    console.error('collectionLinksGet store error:', err);
    return storeUnavailable();
  }
}

export async function handleCollectionLinksPost(
  req: Request,
  deps: CollectionLinksApiDependencies,
): Promise<Response> {
  const gate = await ownerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  const body = await readJsonBody(req);
  const role = body === null ? null : requestedShareRole(body.role);
  if (role === null) {
    return badRequest();
  }
  // Resolved before the write: once a link exists, nothing below may fail and
  // lose the only copy of its URL.
  let origin: string;
  try {
    origin = deps.origin();
  } catch (err) {
    console.error('collectionLinksPost origin error:', err);
    return storeUnavailable();
  }
  const now = deps.now();
  let minted: Awaited<ReturnType<typeof mintCollectionLink>>;
  try {
    minted = await deps.mint(
      { ownerSub: gate.sub, ownerEmail: gate.email, collectionId: gate.collectionId, role },
      now,
    );
  } catch (err) {
    console.error('collectionLinksPost store error:', err);
    return storeUnavailable();
  }
  if (minted.kind === 'collectionMissing') {
    return notFound();
  }
  if (minted.kind === 'cap') {
    return linkCapResponse();
  }
  return mintedLinkResponse({
    origin,
    token: minted.token,
    id: minted.id,
    role,
    now,
    list: () => deps.list(gate.sub, gate.collectionId, now),
  });
}

/**
 * 200 with the one-time `url` and the link's sha256 `id`, always. If the list
 * read fails after the write, `links` holds just the new row and `partial`
 * tells the client to refetch; a 503 here would lose the URL while the link
 * still counts toward the cap.
 */
export async function mintedLinkResponse(input: {
  origin: string;
  token: string;
  id: string;
  role: ShareRole;
  now: number;
  list: () => Promise<CollectionLinkEntry[]>;
}): Promise<Response> {
  const url = collectionLinkUrl(input.origin, input.token);
  // The only time the raw token leaves the server. Never log this body.
  try {
    return jsonResponse({ url, id: input.id, links: await input.list() });
  } catch (err) {
    console.error('collectionLinksPost list after mint failed:', err);
    const row: CollectionLinkEntry = {
      id: input.id,
      role: input.role,
      createdAt: input.now,
      expiresAt: input.now + COLLECTION_LINK_TTL_MS,
    };
    return jsonResponse({ url, id: input.id, links: [row], partial: true });
  }
}

export async function handleCollectionLinksRevokePost(
  req: Request,
  deps: CollectionLinksApiDependencies,
): Promise<Response> {
  const gate = await ownerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  const body = await readJsonBody(req);
  if (body === null || !isCollectionLinkId(body.id)) {
    return badRequest();
  }
  const revokedId = body.id;
  const now = deps.now();
  let outcome: Awaited<ReturnType<typeof revokeCollectionLink>>;
  try {
    outcome = await deps.revoke(gate.sub, gate.collectionId, revokedId, now);
  } catch (err) {
    console.error('collectionLinksRevokePost store error:', err);
    return storeUnavailable();
  }
  if (outcome === 'missing') {
    return notFound();
  }
  return revokedLinkResponse({
    revokedId,
    list: () => deps.list(gate.sub, gate.collectionId, now),
  });
}

/**
 * 200 once the revoke committed, always, with `revokedId`. If the list read
 * after it fails, `links` is empty and `partial` tells the client to drop
 * `revokedId` from what it shows and reread; a 503 here would read as "not
 * revoked" while the link is already dead.
 */
export async function revokedLinkResponse(input: {
  revokedId: string;
  list: () => Promise<CollectionLinkEntry[]>;
}): Promise<Response> {
  try {
    return jsonResponse({ revokedId: input.revokedId, links: await input.list() });
  } catch (err) {
    console.error('collectionLinksRevokePost list after revoke failed:', err);
    return jsonResponse({ revokedId: input.revokedId, links: [], partial: true });
  }
}

export const collectionLinksGet = (req: Request) =>
  handleCollectionLinksGet(req, liveApiDependencies);
export const collectionLinksPost = (req: Request) =>
  handleCollectionLinksPost(req, liveApiDependencies);
export const collectionLinksRevokePost = (req: Request) =>
  handleCollectionLinksRevokePost(req, liveApiDependencies);

// ---------------------------------------------------------------------------
// Visitor pages: GET /c/<token>, GET /c/join, POST /c/join. Server HTML, like
// /invite/<token>. The token only ever appears in the first URL; that request
// swaps it for the signed `sous_collection_link` hop cookie (Path=/c) and
// redirects, so the rendered pages, their Referer, and the Google round trip
// never carry it.
// ---------------------------------------------------------------------------

export type ResolvedCollectionLink = {
  id: string;
  link: CollectionLinkRecord;
  collectionName: string;
};

export type VisitorIdentity = VisitorMembership;

export type CollectionLinkPageDependencies = {
  now: () => number;
  secure: () => boolean;
  origin: () => string;
  /** Live link whose collection is live, or null. Throws on store errors. */
  resolve: (id: string, now: number) => Promise<ResolvedCollectionLink | null>;
  identity: (req: Request) => Promise<VisitorIdentity>;
  /** Throws when unknown, like `sharingOwnerAdmitted`. */
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  redeem: (id: string, redeemer: { sub: string; email: string }) => Promise<CollectionLinkRedeemOutcome>;
};

async function resolveCollectionLink(
  id: string,
  now: number,
): Promise<ResolvedCollectionLink | null> {
  const link = await readCollectionLink(id);
  if (!collectionLinkIsLive(link, now)) {
    return null;
  }
  const collection = await readDocData(link.ownerSub, 'collections', link.collectionId);
  if (collection === undefined || !isLiveDoc(collection)) {
    return null;
  }
  const name = typeof collection.name === 'string' ? collection.name : '';
  return { id, link, collectionName: name };
}

const livePageDependencies: CollectionLinkPageDependencies = {
  now: () => Date.now(),
  secure: isSecureOrigin,
  origin: publicOrigin,
  resolve: resolveCollectionLink,
  identity: visitorMembership,
  ownerAdmitted: sharingOwnerAdmitted,
  redeem: redeemCollectionLink,
};

/**
 * `no-referrer` only where the token is in the URL (the `/c/<token>` landing
 * and its error pages). `/c/join` pages must not use it: a document with
 * `no-referrer` sends its form POSTs with `Origin: null`, which
 * `sameOriginPost` refuses, so Join could never succeed. `same-origin` keeps
 * the (token-free) `/c/join` URL off cross-origin requests.
 */
export type LinkPageReferrerPolicy = 'no-referrer' | 'same-origin';
const LANDING_REFERRER: LinkPageReferrerPolicy = 'no-referrer';
const JOIN_REFERRER: LinkPageReferrerPolicy = 'same-origin';

function pageResponse(
  status: number,
  options: {
    body?: string;
    location?: string;
    cookies?: string[];
    referrer?: LinkPageReferrerPolicy;
  } = {},
): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': options.referrer ?? JOIN_REFERRER,
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  if (options.body !== undefined) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
  }
  if (options.location !== undefined) {
    headers.set('Location', options.location);
  }
  for (const cookie of options.cookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(options.body ?? null, { status, headers });
}

/**
 * The generic "not valid" page. It clears the hop cookie only when asked:
 * that is, only on `/c/join` when the request presented a hop cookie and
 * that cookie's own link is dead. A refused POST, a bogus `/c/<x>`, or a
 * mismatched form must never wipe another in-progress join.
 */
function deadPage(
  deps: CollectionLinkPageDependencies,
  options: { clearHop: boolean; referrer?: LinkPageReferrerPolicy; status?: number },
): Response {
  return pageResponse(options.status ?? 404, {
    body: collectionLinkDeadPageHtml(),
    cookies: options.clearHop ? [clearedCollectionLinkCookie({ secure: deps.secure() })] : [],
    referrer: options.referrer ?? JOIN_REFERRER,
  });
}

function unavailable(referrer: LinkPageReferrerPolicy = JOIN_REFERRER): Response {
  return pageResponse(503, { body: unavailablePageHtml(), referrer });
}

/** The same 403 the OAuth callback shows a non-member. Writes nothing. */
function invitationOnly(identity: { sub: string; email: string }, now: number): Response {
  let requestToken: string | null = null;
  try {
    requestToken = signAccessRequestTx({ sub: identity.sub, email: identity.email }, now);
  } catch (err) {
    console.error('signAccessRequestTx failed:', err);
  }
  return pageResponse(403, { body: invitationOnlyPage({ email: identity.email }, requestToken) });
}

function hopLinkId(req: Request, now: number): string | null {
  const raw = readCookie(req, COLLECTION_LINK_COOKIE_NAME);
  return raw === null ? null : (verifyCollectionLinkTx(raw, now)?.id ?? null);
}

/** GET /c/<token>. Validates, sets the hop cookie, and leaves the token URL at once. */
export async function handleCollectionLinkLanding(
  req: Request,
  deps: CollectionLinkPageDependencies,
): Promise<Response> {
  const token = collectionLinkTokenFromPath(new URL(req.url).pathname);
  // A dead or bogus token leaves any hop cookie alone: it belongs to
  // another link the visitor may be joining.
  if (token === null) {
    return deadPage(deps, { clearHop: false, referrer: LANDING_REFERRER });
  }
  const now = deps.now();
  const id = hashCollectionLinkToken(token);
  try {
    if ((await deps.resolve(id, now)) === null) {
      return deadPage(deps, { clearHop: false, referrer: LANDING_REFERRER });
    }
  } catch (err) {
    console.error('collectionLinkLanding store error:', err);
    return unavailable(LANDING_REFERRER);
  }
  let hop: string;
  try {
    hop = signCollectionLinkTx({ id }, now);
  } catch (err) {
    console.error('signCollectionLinkTx failed:', err);
    return unavailable(LANDING_REFERRER);
  }
  return pageResponse(303, {
    location: '/c/join',
    cookies: [collectionLinkCookie(hop, { secure: deps.secure() })],
    referrer: LANDING_REFERRER,
  });
}

type JoinContext =
  | { kind: 'response'; response: Response }
  | { kind: 'member'; resolved: ResolvedCollectionLink; sub: string; email: string };

/**
 * Shared by GET and POST /c/join: hop cookie → live link → visitor identity →
 * owner still admitted. Only an admitted member or owner gets past it.
 */
async function joinContext(
  req: Request,
  deps: CollectionLinkPageDependencies,
  now: number,
): Promise<JoinContext> {
  const presented = readCookie(req, COLLECTION_LINK_COOKIE_NAME) !== null;
  const id = hopLinkId(req, now);
  if (id === null) {
    // No hop cookie: nothing to clear. An unverifiable one is junk: clear it.
    return { kind: 'response', response: deadPage(deps, { clearHop: presented }) };
  }
  try {
    const resolved = await deps.resolve(id, now);
    if (resolved === null) {
      return { kind: 'response', response: deadPage(deps, { clearHop: true }) };
    }
    const identity = await deps.identity(req);
    if (identity.kind === 'signedOut') {
      return {
        kind: 'response',
        response: pageResponse(200, { body: collectionLinkSignInPageHtml() }),
      };
    }
    if (identity.kind === 'unknown') {
      return { kind: 'response', response: unavailable() };
    }
    if (identity.kind === 'denied') {
      return { kind: 'response', response: invitationOnly(identity, now) };
    }
    if (identity.sub !== resolved.link.ownerSub && !(await deps.ownerAdmitted(resolved.link.ownerSub))) {
      // Grants from an unadmitted owner are inert; the link is as good as dead.
      return { kind: 'response', response: deadPage(deps, { clearHop: true }) };
    }
    return { kind: 'member', resolved, sub: identity.sub, email: identity.email };
  } catch (err) {
    console.error('collectionLinkJoin store error:', err);
    return { kind: 'response', response: unavailable() };
  }
}

function homeRedirect(deps: CollectionLinkPageDependencies): Response {
  return pageResponse(303, {
    location: '/',
    cookies: [clearedCollectionLinkCookie({ secure: deps.secure() })],
  });
}

/** GET /c/join. Renders; never writes. */
export async function handleCollectionLinkJoinGet(
  req: Request,
  deps: CollectionLinkPageDependencies,
): Promise<Response> {
  const context = await joinContext(req, deps, deps.now());
  if (context.kind === 'response') {
    return context.response;
  }
  const { resolved } = context;
  if (context.sub === resolved.link.ownerSub) {
    return homeRedirect(deps);
  }
  return pageResponse(200, {
    body: collectionLinkConfirmPageHtml({
      linkId: resolved.id,
      collectionName: resolved.collectionName,
      ownerEmail: resolved.link.ownerEmail,
      role: resolved.link.role,
    }),
  });
}

/**
 * CSRF check for the Join POST. `SameSite=Lax` already keeps the session and
 * hop cookies off a cross-site POST, so this is a second lock, not the only
 * one, and it fails closed:
 *
 * - `Origin` present: it must be exactly ours. `Origin: null` (sandboxed
 *   frames, `no-referrer` documents, opaque redirects) is refused.
 * - `Origin` absent: `Sec-Fetch-Site` must say `same-origin` (or `none`, a
 *   user-initiated request).
 * - Neither header: refused. Every browser that supports `SameSite` sends
 *   `Origin` on a form POST, so a request with neither comes from a very old
 *   browser or a non-browser client; such a member can be added by email.
 */
export function sameOriginPost(req: Request, origin: string): boolean {
  const header = req.headers.get('origin');
  if (header !== null) {
    return header === origin;
  }
  const site = req.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

/** POST /c/join. The only state-changing step. */
export async function handleCollectionLinkJoinPost(
  req: Request,
  deps: CollectionLinkPageDependencies,
): Promise<Response> {
  let origin: string;
  try {
    origin = deps.origin();
  } catch {
    return unavailable();
  }
  if (!sameOriginPost(req, origin)) {
    // 403 and no Set-Cookie: a cross-site POST must not be able to wipe the
    // visitor's hop cookie.
    return deadPage(deps, { clearHop: false, status: 403 });
  }
  const contentType = req.headers.get('content-type');
  if (
    contentType === null ||
    !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')
  ) {
    return pageResponse(415, { body: collectionLinkDeadPageHtml() });
  }
  const text = await readBoundedText(req, BODY_LIMIT);
  const posted = text === null ? null : new URLSearchParams(text).get('link');

  const now = deps.now();
  const context = await joinContext(req, deps, now);
  if (context.kind === 'response') {
    return context.response;
  }
  // The page named one collection; a hop cookie swapped since then must not
  // redirect the click to another.
  if (posted !== context.resolved.id) {
    // The hop cookie's own link is still live; keep it.
    return deadPage(deps, { clearHop: false });
  }
  if (context.sub === context.resolved.link.ownerSub) {
    return homeRedirect(deps);
  }
  let outcome: CollectionLinkRedeemOutcome;
  try {
    outcome = await deps.redeem(context.resolved.id, { sub: context.sub, email: context.email });
  } catch (err) {
    console.error('collectionLinkRedeem store error:', err);
    return unavailable();
  }
  if (outcome.kind === 'dead') {
    return deadPage(deps, { clearHop: true });
  }
  if (outcome.kind === 'cap') {
    return pageResponse(409, { body: collectionLinkFullPageHtml() });
  }
  return homeRedirect(deps);
}

export const collectionLinkLandingGet = (req: Request) =>
  handleCollectionLinkLanding(req, livePageDependencies);
export const collectionLinkJoinGet = (req: Request) =>
  handleCollectionLinkJoinGet(req, livePageDependencies);
export const collectionLinkJoinPost = (req: Request) =>
  handleCollectionLinkJoinPost(req, livePageDependencies);
