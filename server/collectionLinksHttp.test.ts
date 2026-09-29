import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionLinkDeadPageHtml } from './access.ts';
import {
  COLLECTION_LINK_TTL_MS,
  hashCollectionLinkToken,
  type CollectionLinkRecord,
  type CollectionLinkRedeemOutcome,
} from './collectionLinks.ts';
import {
  collectionIdFromLinksPath,
  handleCollectionLinkJoinGet,
  handleCollectionLinkJoinPost,
  handleCollectionLinkLanding,
  handleCollectionLinksGet,
  handleCollectionLinksPost,
  handleCollectionLinksRevokePost,
  sameOriginPost,
  type CollectionLinkPageDependencies,
  type CollectionLinksApiDependencies,
  type ResolvedCollectionLink,
  type VisitorIdentity,
} from './collectionLinksHttp.ts';
import {
  COLLECTION_LINK_COOKIE_NAME,
  INVITE_COOKIE_NAME,
  OAUTH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  signCollectionLinkTx,
  signInviteTx,
} from './session.ts';

const ORIGIN = 'https://sous.example';
const now = 1_700_000_000_000;
const token = 'T'.repeat(43);
const linkId = hashCollectionLinkToken(token);
const ownerSub = 'owner-sub';
const collectionId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-collection-links';
});

function link(overrides: Partial<CollectionLinkRecord> = {}): CollectionLinkRecord {
  return {
    ownerSub,
    ownerEmail: 'owner@example.com',
    collectionId,
    role: 'viewer',
    status: 'live',
    createdAt: now - 1,
    expiresAt: now + COLLECTION_LINK_TTL_MS,
    ...overrides,
  };
}

function resolved(overrides: Partial<ResolvedCollectionLink> = {}): ResolvedCollectionLink {
  return { id: linkId, link: link(), collectionName: 'Soups <b>', ...overrides };
}

function pageDeps(overrides: Partial<CollectionLinkPageDependencies> = {}) {
  const redeem = vi.fn(
    async (): Promise<CollectionLinkRedeemOutcome> => ({ kind: 'write' }),
  );
  const deps: CollectionLinkPageDependencies = {
    now: () => now,
    secure: () => true,
    origin: () => ORIGIN,
    resolve: async (id) => (id === linkId ? resolved() : null),
    identity: async (): Promise<VisitorIdentity> => ({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    }),
    ownerAdmitted: async () => true,
    redeem,
    ...overrides,
  };
  return { deps, redeem: (overrides.redeem as typeof redeem | undefined) ?? redeem };
}

function hopCookie(id = linkId): string {
  return `${COLLECTION_LINK_COOKIE_NAME}=${signCollectionLinkTx({ id }, now)}`;
}

function joinGet(cookie?: string): Request {
  return new Request(`${ORIGIN}/c/join`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function joinPost(options: { cookie?: string; body?: string; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  if (options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN;
  }
  return new Request(`${ORIGIN}/c/join`, {
    method: 'POST',
    headers,
    body: options.body ?? `link=${linkId}`,
  });
}

describe('hop cookie', () => {
  it('has its own name, distinct from session, oauth, and app invite cookies', () => {
    expect(COLLECTION_LINK_COOKIE_NAME).toBe('sous_collection_link');
    expect(
      new Set([COLLECTION_LINK_COOKIE_NAME, INVITE_COOKIE_NAME, OAUTH_COOKIE_NAME, SESSION_COOKIE_NAME])
        .size,
    ).toBe(4);
  });

  it('an app invite hop token is not accepted as a collection link hop', async () => {
    const { deps } = pageDeps();
    const inviteHop = `${COLLECTION_LINK_COOKIE_NAME}=${signInviteTx({ id: linkId }, now)}`;
    const response = await handleCollectionLinkJoinGet(joinGet(inviteHop), deps);
    expect(response.status).toBe(404);
  });
});

describe('GET /c/<token>', () => {
  it('swaps a live token for the hop cookie and leaves the token URL', async () => {
    const { deps } = pageDeps();
    const response = await handleCollectionLinkLanding(new Request(`${ORIGIN}/c/${token}`), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/c/join');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^sous_collection_link=/);
    expect(cookies[0]).toContain('Path=/c');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Lax');
    expect(cookies[0]).not.toContain(token);
  });

  it('renders one generic page for malformed, unknown, revoked, expired, or deleted', async () => {
    const { deps } = pageDeps({ resolve: async () => null });
    const malformed = await handleCollectionLinkLanding(new Request(`${ORIGIN}/c/nope`), deps);
    const dead = await handleCollectionLinkLanding(new Request(`${ORIGIN}/c/${token}`), deps);
    for (const response of [malformed, dead]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(await response.text()).toBe(collectionLinkDeadPageHtml());
    }
  });

  it('a store error is 503, not the dead page', async () => {
    const { deps } = pageDeps({
      resolve: async () => {
        throw new Error('firestore down');
      },
    });
    const response = await handleCollectionLinkLanding(new Request(`${ORIGIN}/c/${token}`), deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('GET /c/join', () => {
  it('without a hop cookie is the generic page', async () => {
    const { deps } = pageDeps();
    const response = await handleCollectionLinkJoinGet(joinGet(), deps);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(collectionLinkDeadPageHtml());
  });

  it('a revoked link after the hop is the generic page', async () => {
    const { deps } = pageDeps({ resolve: async () => null });
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(collectionLinkDeadPageHtml());
  });

  it('signed out: sign in and come back to /c/join; names no collection', async () => {
    const { deps } = pageDeps({ identity: async () => ({ kind: 'signedOut' }) });
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('/api/auth/start?returnTo=%2Fc%2Fjoin');
    expect(body).not.toContain('Soups');
  });

  it('signed-in non-member sees the invitation-only page and nothing is redeemed', async () => {
    const { deps, redeem } = pageDeps({
      identity: async () => ({ kind: 'denied', sub: 'stranger', email: 'stranger@example.com' }),
    });
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('invitation-only');
    expect(redeem).not.toHaveBeenCalled();
  });

  it('membership unknown is 503', async () => {
    const { deps } = pageDeps({ identity: async () => ({ kind: 'unknown' }) });
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(503);
  });

  it('member sees a confirm form, escaped, and GET never redeems', async () => {
    const { deps, redeem } = pageDeps();
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Soups &lt;b&gt;');
    expect(body).toContain('method="POST" action="/c/join"');
    expect(body).toContain(`value="${linkId}"`);
    expect(body).not.toContain(token);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(redeem).not.toHaveBeenCalled();
  });

  it('confirm page is same-origin, not no-referrer, so its Join POST carries a real Origin', async () => {
    const { deps } = pageDeps();
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(response.headers.get('Referrer-Policy')).not.toBe('no-referrer');
  });

  it('every /c/join page (sign-in, invitation-only, dead, unavailable) is same-origin', async () => {
    const cases: Partial<CollectionLinkPageDependencies>[] = [
      { identity: async () => ({ kind: 'signedOut' }) },
      { identity: async () => ({ kind: 'denied', sub: 's', email: 's@example.com' }) },
      { resolve: async () => null },
      { identity: async () => ({ kind: 'unknown' }) },
    ];
    for (const overrides of cases) {
      const { deps } = pageDeps(overrides);
      const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
      expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
    }
    const { deps } = pageDeps({ redeem: vi.fn(async () => ({ kind: 'cap' }) as const) });
    const full = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(full.status).toBe(409);
    expect(full.headers.get('Referrer-Policy')).toBe('same-origin');
  });

  it('the owner opening their own link goes home without a confirm', async () => {
    const { deps, redeem } = pageDeps({
      identity: async () => ({ kind: 'ok', sub: ownerSub, email: 'owner@example.com', isOwner: false }),
    });
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/');
    expect(redeem).not.toHaveBeenCalled();
  });

  it('an unadmitted collection owner makes the link generic', async () => {
    const { deps } = pageDeps({ ownerAdmitted: async () => false });
    const response = await handleCollectionLinkJoinGet(joinGet(hopCookie()), deps);
    expect(response.status).toBe(404);
  });
});

describe('POST /c/join', () => {
  it('member redeem calls redeem once with the session identity and goes home', async () => {
    const { deps, redeem } = pageDeps();
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/');
    expect(response.headers.getSetCookie()[0]).toMatch(/^sous_collection_link=;.*Max-Age=0/);
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(redeem).toHaveBeenCalledWith(linkId, { sub: 'member-sub', email: 'member@example.com' });
  });

  it('an already-granted member is still sent home (idempotent)', async () => {
    const { deps } = pageDeps({ redeem: vi.fn(async () => ({ kind: 'idempotent' }) as const) });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(303);
  });

  it('non-member: invitation-only page, no redeem, no member', async () => {
    const { deps, redeem } = pageDeps({
      identity: async () => ({ kind: 'denied', sub: 'stranger', email: 'stranger@example.com' }),
    });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(403);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('signed out: no redeem', async () => {
    const { deps, redeem } = pageDeps({ identity: async () => ({ kind: 'signedOut' }) });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(200);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('cross-origin POST is refused before anything is read', async () => {
    const identity = vi.fn(async (): Promise<VisitorIdentity> => ({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    }));
    const { deps, redeem } = pageDeps({ identity });
    const response = await handleCollectionLinkJoinPost(
      joinPost({ cookie: hopCookie(), origin: 'https://evil.example' }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(identity).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
  });

  it('a Join POST with Origin: null is refused before anything is read', async () => {
    const identity = vi.fn(async (): Promise<VisitorIdentity> => ({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    }));
    const { deps, redeem } = pageDeps({ identity });
    const response = await handleCollectionLinkJoinPost(
      joinPost({ cookie: hopCookie(), origin: 'null' }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(identity).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
  });

  it('a Join POST with no Origin needs Sec-Fetch-Site same-origin', async () => {
    const refused = pageDeps();
    const bare = await handleCollectionLinkJoinPost(
      joinPost({ cookie: hopCookie(), origin: null }),
      refused.deps,
    );
    expect(bare.status).toBe(404);
    expect(refused.redeem).not.toHaveBeenCalled();

    const allowed = pageDeps();
    const request = joinPost({ cookie: hopCookie(), origin: null });
    request.headers.set('sec-fetch-site', 'same-origin');
    const ok = await handleCollectionLinkJoinPost(request, allowed.deps);
    expect(ok.status).toBe(303);
    expect(allowed.redeem).toHaveBeenCalledTimes(1);
  });

  it('a posted link that does not match the hop cookie redeems nothing', async () => {
    const { deps, redeem } = pageDeps();
    const response = await handleCollectionLinkJoinPost(
      joinPost({ cookie: hopCookie(), body: `link=${'f'.repeat(64)}` }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('the owner posting their own link writes no self-grant', async () => {
    const { deps, redeem } = pageDeps({
      identity: async () => ({ kind: 'ok', sub: ownerSub, email: 'owner@example.com', isOwner: false }),
    });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(303);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('a link that died in the transaction (revoked, expired, collection deleted) is generic', async () => {
    const { deps } = pageDeps({ redeem: vi.fn(async () => ({ kind: 'dead' }) as const) });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(collectionLinkDeadPageHtml());
  });

  it('at the grant cap shows the full page and keeps the hop cookie', async () => {
    const { deps } = pageDeps({ redeem: vi.fn(async () => ({ kind: 'cap' }) as const) });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('owner membership unknown is 503 and redeems nothing', async () => {
    const { deps, redeem } = pageDeps({
      ownerAdmitted: async () => {
        throw new Error('unknown');
      },
    });
    const response = await handleCollectionLinkJoinPost(joinPost({ cookie: hopCookie() }), deps);
    expect(response.status).toBe(503);
    expect(redeem).not.toHaveBeenCalled();
  });
});

describe('sameOriginPost', () => {
  const req = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/c/join`, { method: 'POST', headers });

  it('with Origin, accepts only exactly our origin (never null)', () => {
    expect(sameOriginPost(req({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(sameOriginPost(req({ origin: 'null' }), ORIGIN)).toBe(false);
    expect(sameOriginPost(req({ origin: 'https://evil.example' }), ORIGIN)).toBe(false);
    expect(sameOriginPost(req({ origin: `${ORIGIN}.evil.example` }), ORIGIN)).toBe(false);
  });

  it('Origin wins over Sec-Fetch-Site when both are present', () => {
    expect(
      sameOriginPost(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }), ORIGIN),
    ).toBe(false);
    expect(
      sameOriginPost(req({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }), ORIGIN),
    ).toBe(false);
    expect(sameOriginPost(req({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(
      true,
    );
  });

  it('without Origin, needs Sec-Fetch-Site same-origin or none', () => {
    expect(sameOriginPost(req({ 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(true);
    expect(sameOriginPost(req({ 'sec-fetch-site': 'none' }), ORIGIN)).toBe(true);
    expect(sameOriginPost(req({ 'sec-fetch-site': 'same-site' }), ORIGIN)).toBe(false);
    expect(sameOriginPost(req({ 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe(false);
    expect(sameOriginPost(req({ 'sec-fetch-site': 'bogus' }), ORIGIN)).toBe(false);
  });

  it('with neither header, refuses', () => {
    expect(sameOriginPost(req({}), ORIGIN)).toBe(false);
  });
});

describe('owner API /api/collections/:id/links', () => {
  function apiDeps(overrides: Partial<CollectionLinksApiDependencies> = {}) {
    const mint = vi.fn<CollectionLinksApiDependencies['mint']>(async () => ({
      kind: 'ok',
      token,
      id: linkId,
    }));
    const revoke = vi.fn<CollectionLinksApiDependencies['revoke']>(async () => 'ok');
    const deps: CollectionLinksApiDependencies = {
      requireOwnedLiveCollection: async () => ({
        kind: 'ok',
        sub: ownerSub,
        email: 'owner@example.com',
      }),
      list: async () => [{ id: linkId, role: 'viewer', createdAt: now, expiresAt: now + 1 }],
      mint,
      revoke,
      origin: () => ORIGIN,
      now: () => now,
      ...overrides,
    };
    return { deps, mint, revoke };
  }

  const base = `${ORIGIN}/api/collections/${collectionId}/links`;

  it('parses the collection id from list, mint, and revoke paths only', () => {
    expect(collectionIdFromLinksPath(`/api/collections/${collectionId}/links`)).toBe(collectionId);
    expect(collectionIdFromLinksPath(`/api/collections/${collectionId}/links/revoke`)).toBe(
      collectionId,
    );
    expect(collectionIdFromLinksPath('/api/collections/nope/links')).toBeNull();
    expect(collectionIdFromLinksPath(`/api/collections/${collectionId}/grants`)).toBeNull();
  });

  it('mint returns the URL once with the chosen role', async () => {
    const { deps, mint } = apiDeps();
    const response = await handleCollectionLinksPost(
      new Request(base, { method: 'POST', body: JSON.stringify({ role: 'editor' }) }),
      deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; id: string; links: unknown[] };
    expect(body.url).toBe(`${ORIGIN}/c/${token}`);
    expect(body.id).toBe(linkId);
    expect(body.id).not.toContain(token);
    expect(body).not.toHaveProperty('partial');
    expect(mint).toHaveBeenCalledWith(
      { ownerSub, ownerEmail: 'owner@example.com', collectionId, role: 'editor' },
      now,
    );
  });

  it('a list failure after a successful mint still returns the URL, with partial rows', async () => {
    const { deps } = apiDeps({
      list: async () => {
        throw new Error('firestore blip');
      },
    });
    const response = await handleCollectionLinksPost(
      new Request(base, { method: 'POST', body: JSON.stringify({ role: 'editor' }) }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: `${ORIGIN}/c/${token}`,
      id: linkId,
      links: [{ id: linkId, role: 'editor', createdAt: now, expiresAt: now + COLLECTION_LINK_TTL_MS }],
      partial: true,
    });
  });

  it('a mint store failure is 503 and nothing was minted', async () => {
    const { deps } = apiDeps({
      mint: vi.fn(async () => {
        throw new Error('firestore down');
      }),
    });
    const response = await handleCollectionLinksPost(
      new Request(base, { method: 'POST', body: '{}' }),
      deps,
    );
    expect(response.status).toBe(503);
  });

  it('list never includes a URL or token', async () => {
    const { deps } = apiDeps();
    const response = await handleCollectionLinksGet(new Request(base), deps);
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain('url');
  });

  it('non-owner or missing collection is 404 and never mints', async () => {
    const { deps, mint } = apiDeps({ requireOwnedLiveCollection: async () => ({ kind: 'missing' }) });
    const response = await handleCollectionLinksPost(
      new Request(base, { method: 'POST', body: '{}' }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(mint).not.toHaveBeenCalled();
  });

  it('denied is 401 and unknown is 503', async () => {
    const denied = apiDeps({ requireOwnedLiveCollection: async () => ({ kind: 'denied' }) });
    expect((await handleCollectionLinksGet(new Request(base), denied.deps)).status).toBe(401);
    const unknown = apiDeps({ requireOwnedLiveCollection: async () => ({ kind: 'unknown' }) });
    expect((await handleCollectionLinksGet(new Request(base), unknown.deps)).status).toBe(503);
  });

  it('bad role is 400; cap is 409', async () => {
    const { deps } = apiDeps();
    const bad = await handleCollectionLinksPost(
      new Request(base, { method: 'POST', body: JSON.stringify({ role: 'owner' }) }),
      deps,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: 'bad-request', error: 'Bad request' });
    const capped = apiDeps({ mint: vi.fn(async () => ({ kind: 'cap' }) as const) });
    const cap = await handleCollectionLinksPost(
      new Request(base, { method: 'POST', body: '{}' }),
      capped.deps,
    );
    expect(cap.status).toBe(409);
    expect(await cap.json()).toEqual({
      code: 'link-cap',
      error: 'This collection already has 20 live links. Revoke one first.',
      max: 20,
    });
  });

  it('404s carry the not-found code', async () => {
    const { deps } = apiDeps({ requireOwnedLiveCollection: async () => ({ kind: 'missing' }) });
    const response = await handleCollectionLinksGet(new Request(base), deps);
    expect(await response.json()).toEqual({ code: 'not-found', error: 'Not found' });
  });

  it('revoke needs a sha256 id and answers 404 for a link that is not this collection’s', async () => {
    const { deps, revoke } = apiDeps();
    const bad = await handleCollectionLinksRevokePost(
      new Request(`${base}/revoke`, { method: 'POST', body: JSON.stringify({ id: token }) }),
      deps,
    );
    expect(bad.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();

    const missing = apiDeps({ revoke: vi.fn(async () => 'missing' as const) });
    const response = await handleCollectionLinksRevokePost(
      new Request(`${base}/revoke`, { method: 'POST', body: JSON.stringify({ id: linkId }) }),
      missing.deps,
    );
    expect(response.status).toBe(404);

    const ok = await handleCollectionLinksRevokePost(
      new Request(`${base}/revoke`, { method: 'POST', body: JSON.stringify({ id: linkId }) }),
      deps,
    );
    expect(ok.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(ownerSub, collectionId, linkId, now);
  });
});
