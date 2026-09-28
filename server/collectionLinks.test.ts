import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_LINK_TTL_MS,
  MAX_LIVE_COLLECTION_LINKS,
  collectionLinkEntries,
  collectionLinkIsLive,
  collectionLinkTokenFromPath,
  hashCollectionLinkToken,
  mintCollectionLinkRecord,
  orchestrateCollectionLinkRedeem,
  parseCollectionLinkDoc,
  revokeCollectionLinkTransition,
  type CollectionLinkRecord,
  type CollectionLinkRedeemDependencies,
} from './collectionLinks.ts';
import {
  MAX_LIVE_GRANTS,
  type ForwardGrantSnap,
  type IncomingShareDoc,
  type LiveGrant,
} from './grants.ts';
import { INVITE_TTL_MS } from './invites.ts';

const now = 1_700_000_000_000;
const ownerSub = 'owner-sub';
const collectionId = '11111111-1111-4111-8111-111111111111';
const member = { sub: 'member-sub', email: 'Member@Example.com' };

function liveLink(overrides: Partial<CollectionLinkRecord> = {}): CollectionLinkRecord {
  return {
    ownerSub,
    ownerEmail: 'owner@example.com',
    collectionId,
    role: 'viewer',
    status: 'live',
    createdAt: now - 1_000,
    expiresAt: now + COLLECTION_LINK_TTL_MS,
    ...overrides,
  };
}

function liveCollection(): Record<string, unknown> {
  return { id: collectionId, name: 'Weeknights', recipeIds: [], updatedAt: now - 5_000 };
}

function liveGrantDoc(viewerSub: string, role: 'viewer' | 'editor' = 'viewer'): LiveGrant {
  return {
    viewerSub,
    email: `${viewerSub}@example.com`,
    collectionId,
    role,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    active: true,
  };
}

/** In-memory stand-in for one Firestore transaction, shaped by the real transaction types. */
function fakeRedeemStore(initial: {
  link: CollectionLinkRecord | null;
  collection?: Record<string, unknown> | undefined;
  grants?: ForwardGrantSnap[];
}) {
  const state = {
    link: initial.link,
    collection: 'collection' in initial ? initial.collection : liveCollection(),
    grants: initial.grants ?? [],
  };
  const writes: { grant: LiveGrant; share: IncomingShareDoc }[] = [];
  const grantScopes: { ownerSub: string; collectionId: string }[] = [];
  const deps: CollectionLinkRedeemDependencies = {
    now: () => now,
    runTransaction: (work) =>
      work({
        readLink: async () => state.link,
        grantsFor: (scopeOwner, scopeCollection) => {
          grantScopes.push({ ownerSub: scopeOwner, collectionId: scopeCollection });
          return {
            readCollection: async () => state.collection,
            readForwardGrants: async () => state.grants,
            writePair: (grant, share) => {
              writes.push({ grant, share });
              state.grants = [
                ...state.grants.filter((doc) => doc.id !== grant.viewerSub),
                { id: grant.viewerSub, data: { ...grant } },
              ];
            },
          };
        },
      }),
  };
  return { deps, writes, grantScopes };
}

describe('hashCollectionLinkToken / mintCollectionLinkRecord', () => {
  it('stores only sha256(token): the raw token is absent from the id and the document', () => {
    const minted = mintCollectionLinkRecord(
      { ownerSub, ownerEmail: 'owner@example.com', collectionId, role: 'editor' },
      now,
    );
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.id).toBe(createHash('sha256').update(minted.token, 'utf8').digest('hex'));
    expect(hashCollectionLinkToken(minted.token)).toBe(minted.id);
    expect(minted.id).not.toContain(minted.token);
    expect(JSON.stringify(minted.record)).not.toContain(minted.token);
    expect(minted.record).toEqual({
      ownerSub,
      ownerEmail: 'owner@example.com',
      collectionId,
      role: 'editor',
      status: 'live',
      createdAt: now,
      expiresAt: now + COLLECTION_LINK_TTL_MS,
    });
  });

  it('matches the app invite TTL of 7 days and caps at 20 live links', () => {
    expect(COLLECTION_LINK_TTL_MS).toBe(INVITE_TTL_MS);
    expect(COLLECTION_LINK_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MAX_LIVE_COLLECTION_LINKS).toBe(20);
  });

  it('mints a different token every time', () => {
    const input = { ownerSub, ownerEmail: '', collectionId, role: 'viewer' as const };
    expect(mintCollectionLinkRecord(input, now).token).not.toBe(
      mintCollectionLinkRecord(input, now).token,
    );
  });
});

describe('collectionLinkTokenFromPath', () => {
  const token = 'A'.repeat(43);

  it('accepts /c/<token>', () => {
    expect(collectionLinkTokenFromPath(`/c/${token}`)).toBe(token);
  });

  it('rejects the join path, empty, nested, short, and look-alike prefixes', () => {
    expect(collectionLinkTokenFromPath('/c/join')).toBeNull();
    expect(collectionLinkTokenFromPath('/c/')).toBeNull();
    expect(collectionLinkTokenFromPath(`/c/${token}/x`)).toBeNull();
    expect(collectionLinkTokenFromPath('/c/short')).toBeNull();
    expect(collectionLinkTokenFromPath(`/cooks/${token}`)).toBeNull();
    expect(collectionLinkTokenFromPath(`/invite/${token}`)).toBeNull();
  });
});

describe('parseCollectionLinkDoc', () => {
  it('round-trips a stored record', () => {
    const record = liveLink({ role: 'editor' });
    expect(parseCollectionLinkDoc({ ...record })).toEqual(record);
    const revoked = liveLink({ status: 'revoked', revokedAt: now });
    expect(parseCollectionLinkDoc({ ...revoked })).toEqual(revoked);
  });

  it.each([
    ['not an object', null],
    ['missing owner', { ...liveLink(), ownerSub: '' }],
    ['bad collection id', { ...liveLink(), collectionId: 'nope' }],
    ['unknown role', { ...liveLink(), role: 'admin' }],
    ['unknown status', { ...liveLink(), status: 'unused' }],
    ['bad expiry', { ...liveLink(), expiresAt: 'soon' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseCollectionLinkDoc(raw)).toBeNull();
  });
});

describe('collectionLinkIsLive / collectionLinkEntries', () => {
  it('treats unknown, revoked, and expired the same: not live', () => {
    expect(collectionLinkIsLive(null, now)).toBe(false);
    expect(collectionLinkIsLive(liveLink({ status: 'revoked', revokedAt: now }), now)).toBe(false);
    expect(collectionLinkIsLive(liveLink({ expiresAt: now }), now)).toBe(false);
    expect(collectionLinkIsLive(liveLink(), now)).toBe(true);
  });

  it('lists live links newest first, without owner fields', () => {
    const entries = collectionLinkEntries(
      [
        { id: 'a'.repeat(64), record: liveLink({ createdAt: now - 2 }) },
        { id: 'b'.repeat(64), record: liveLink({ createdAt: now - 1, role: 'editor' }) },
        { id: 'c'.repeat(64), record: liveLink({ expiresAt: now - 1 }) },
        { id: 'd'.repeat(64), record: liveLink({ status: 'revoked', revokedAt: now }) },
      ],
      now,
    );
    expect(entries).toEqual([
      { id: 'b'.repeat(64), role: 'editor', createdAt: now - 1, expiresAt: now + COLLECTION_LINK_TTL_MS },
      { id: 'a'.repeat(64), role: 'viewer', createdAt: now - 2, expiresAt: now + COLLECTION_LINK_TTL_MS },
    ]);
  });
});

describe('revokeCollectionLinkTransition', () => {
  it('revokes a live link of this owner and collection', () => {
    expect(
      revokeCollectionLinkTransition({ existing: liveLink(), ownerSub, collectionId, now }),
    ).toEqual({ kind: 'write', record: { ...liveLink(), status: 'revoked', revokedAt: now } });
  });

  it('reads another owner, another collection, unknown, or already revoked as missing', () => {
    const cases: Parameters<typeof revokeCollectionLinkTransition>[0][] = [
      { existing: null, ownerSub, collectionId, now },
      { existing: liveLink(), ownerSub: 'someone-else', collectionId, now },
      { existing: liveLink(), ownerSub, collectionId: '22222222-2222-4222-8222-222222222222', now },
      { existing: liveLink({ status: 'revoked', revokedAt: now - 1 }), ownerSub, collectionId, now },
    ];
    for (const input of cases) {
      expect(revokeCollectionLinkTransition(input)).toEqual({ kind: 'missing' });
    }
  });
});

describe('orchestrateCollectionLinkRedeem', () => {
  it('member redeem writes one grant pair with the link role', async () => {
    const store = fakeRedeemStore({ link: liveLink({ role: 'editor' }) });
    const outcome = await orchestrateCollectionLinkRedeem(member, store.deps);
    expect(outcome).toEqual({ kind: 'write' });
    expect(store.grantScopes).toEqual([{ ownerSub, collectionId }]);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].grant).toEqual({
      viewerSub: member.sub,
      email: 'member@example.com',
      collectionId,
      role: 'editor',
      createdAt: now,
      updatedAt: now,
      active: true,
    });
    expect(store.writes[0].share).toEqual({
      ownerSub,
      collectionId,
      ownerEmail: 'owner@example.com',
      role: 'editor',
      updatedAt: now,
    });
  });

  it('a second redeem is idempotent and writes nothing more', async () => {
    const store = fakeRedeemStore({ link: liveLink() });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({ kind: 'write' });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({
      kind: 'idempotent',
    });
    expect(store.writes).toHaveLength(1);
  });

  it('keeps an existing grant role: an editor link does not upgrade a viewer', async () => {
    const store = fakeRedeemStore({
      link: liveLink({ role: 'editor' }),
      grants: [{ id: member.sub, data: { ...liveGrantDoc(member.sub, 'viewer') } }],
    });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({
      kind: 'idempotent',
    });
    expect(store.writes).toHaveLength(0);
  });

  it('keeps an existing grant role: a viewer link does not downgrade an editor', async () => {
    const store = fakeRedeemStore({
      link: liveLink({ role: 'viewer' }),
      grants: [{ id: member.sub, data: { ...liveGrantDoc(member.sub, 'editor') } }],
    });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({
      kind: 'idempotent',
    });
    expect(store.writes).toHaveLength(0);
  });

  it.each([
    ['unknown', null],
    ['expired', liveLink({ expiresAt: now })],
    ['revoked', liveLink({ status: 'revoked', revokedAt: now - 1 })],
  ])('a %s link is dead and writes nothing', async (_label, link) => {
    const store = fakeRedeemStore({ link });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({ kind: 'dead' });
    expect(store.writes).toHaveLength(0);
    expect(store.grantScopes).toHaveLength(0);
  });

  it('a link for a deleted collection is dead and writes nothing', async () => {
    const tombstone = { ...liveCollection(), deletedAt: now - 1, updatedAt: now - 1 };
    for (const collection of [tombstone, undefined]) {
      const store = fakeRedeemStore({ link: liveLink(), collection });
      expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({ kind: 'dead' });
      expect(store.writes).toHaveLength(0);
    }
  });

  it('the collection owner redeeming their own link creates no self-grant', async () => {
    const store = fakeRedeemStore({ link: liveLink() });
    expect(
      await orchestrateCollectionLinkRedeem({ sub: ownerSub, email: 'owner@example.com' }, store.deps),
    ).toEqual({ kind: 'self' });
    expect(store.writes).toHaveLength(0);
    expect(store.grantScopes).toHaveLength(0);
  });

  it('at the 20-grant cap a new redeemer writes nothing and the link stays live', async () => {
    const grants = Array.from({ length: MAX_LIVE_GRANTS }, (_, i) => ({
      id: `viewer-${i}`,
      data: { ...liveGrantDoc(`viewer-${i}`) } as Record<string, unknown>,
    }));
    const link = liveLink();
    const store = fakeRedeemStore({ link, grants });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({ kind: 'cap' });
    expect(store.writes).toHaveLength(0);
    expect(collectionLinkIsLive(link, now)).toBe(true);
  });

  it('at the cap an already-granted member is still idempotent', async () => {
    const grants = Array.from({ length: MAX_LIVE_GRANTS }, (_, i) => ({
      id: i === 0 ? member.sub : `viewer-${i}`,
      data: { ...liveGrantDoc(i === 0 ? member.sub : `viewer-${i}`) } as Record<string, unknown>,
    }));
    const store = fakeRedeemStore({ link: liveLink(), grants });
    expect(await orchestrateCollectionLinkRedeem(member, store.deps)).toEqual({
      kind: 'idempotent',
    });
  });
});
