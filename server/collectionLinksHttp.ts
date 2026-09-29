import {
  collectionLinkConfirmPageHtml,
  collectionLinkDeadPageHtml,
  collectionLinkFullPageHtml,
  collectionLinkSignInPageHtml,
  invitationOnlyPage,
  unavailablePageHtml,
} from './access.ts';
import {
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
import { requestedShareRole } from './shareAuth.ts';
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
  try {
    const now = deps.now();
    const minted = await deps.mint(
      { ownerSub: gate.sub, ownerEmail: gate.email, collectionId: gate.collectionId, role },
      now,
    );
    if (minted.kind === 'collectionMissing') {
      return notFound();
    }
    if (minted.kind === 'cap') {
      return linkCapResponse();
    }
    const links = await deps.list(gate.sub, gate.collectionId, now);
    // The only time the raw token leaves the server. Never log this body.
    return jsonResponse({ url: collectionLinkUrl(deps.origin(), minted.token), links });
  } catch (err) {
    console.error('collectionLinksPost store error:', err);
    return storeUnavailable();
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
  try {
    const now = deps.now();
    const outcome = await deps.revoke(gate.sub, gate.collectionId, body.id, now);
    if (outcome === 'missing') {
      return notFound();
    }
    return jsonResponse({ links: await deps.list(gate.sub, gate.collectionId, now) });
  } catch (err) {
    console.error('collectionLinksRevokePost store error:', err);
    return storeUnavailable();
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

function pageResponse(
  status: number,
  options: { body?: string; location?: string; cookies?: string[] } = {},
): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
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

function deadPage(deps: CollectionLinkPageDependencies): Response {
  return pageResponse(404, {
    body: collectionLinkDeadPageHtml(),
    cookies: [clearedCollectionLinkCookie({ secure: deps.secure() })],
  });
}

function unavailable(): Response {
  return pageResponse(503, { body: unavailablePageHtml() });
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
  if (token === null) {
    return deadPage(deps);
  }
  const now = deps.now();
  const id = hashCollectionLinkToken(token);
  try {
    if ((await deps.resolve(id, now)) === null) {
      return deadPage(deps);
    }
  } catch (err) {
    console.error('collectionLinkLanding store error:', err);
    return unavailable();
  }
  let hop: string;
  try {
    hop = signCollectionLinkTx({ id }, now);
  } catch (err) {
    console.error('signCollectionLinkTx failed:', err);
    return unavailable();
  }
  return pageResponse(303, {
    location: '/c/join',
    cookies: [collectionLinkCookie(hop, { secure: deps.secure() })],
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
  const id = hopLinkId(req, now);
  if (id === null) {
    return { kind: 'response', response: deadPage(deps) };
  }
  try {
    const resolved = await deps.resolve(id, now);
    if (resolved === null) {
      return { kind: 'response', response: deadPage(deps) };
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
      return { kind: 'response', response: deadPage(deps) };
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
 * A browser attaches `Origin` to a form POST. When it is present it must be
 * ours; `SameSite=Lax` already keeps the session and hop cookies off a
 * cross-site POST, so this is a second lock, not the only one.
 */
export function sameOriginPost(req: Request, origin: string): boolean {
  const header = req.headers.get('origin');
  if (header === null) {
    return req.headers.get('sec-fetch-site') !== 'cross-site';
  }
  return header === origin;
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
    return deadPage(deps);
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
    return deadPage(deps);
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
    return deadPage(deps);
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
