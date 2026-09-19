import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashInviteToken,
  inviteLandingVerdict,
  inviteTokenFromPath,
  isInviteTokenShape,
  mintInviteRecord,
  parseInviteDoc,
  redeemInviteTransition,
  revokeInviteTransition,
  unusedUnexpired,
  INVITE_TTL_MS,
  INVITE_UNUSED_CAP,
  type InviteRecord,
} from './invites.ts';
import type { AccessRequestRecord } from './members.ts';

const now = 1_700_000_000_000;
const identity = { sub: 'guest-sub', email: 'guest@example.com', name: 'Guest' };

function unusedInvite(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return {
    status: 'unused',
    createdAt: now,
    createdBy: 'owner-sub',
    expiresAt: now + INVITE_TTL_MS,
    ...overrides,
  };
}

describe('hashInviteToken', () => {
  it('is sha256 hex of the utf8 token', () => {
    const token = 'abc';
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(hashInviteToken(token)).toBe(expected);
    expect(hashInviteToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('isInviteTokenShape / inviteTokenFromPath', () => {
  it('accepts a 32-byte base64url token path', () => {
    const token = 'A'.repeat(43);
    expect(isInviteTokenShape(token)).toBe(true);
    expect(inviteTokenFromPath(`/invite/${token}`)).toBe(token);
  });

  it('rejects extra segments, short tokens, and query-looking junk', () => {
    expect(inviteTokenFromPath('/invite/')).toBeNull();
    expect(inviteTokenFromPath('/invite/abc')).toBeNull();
    expect(inviteTokenFromPath('/invite/foo/bar')).toBeNull();
    expect(inviteTokenFromPath('/invite/not valid')).toBeNull();
    expect(inviteTokenFromPath('/invites/aaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });
});

describe('parseInviteDoc', () => {
  const valid = {
    status: 'unused' as const,
    createdAt: 1,
    createdBy: 'owner',
    expiresAt: 2,
  };

  it('returns a record for a fully-formed unused document', () => {
    expect(parseInviteDoc(valid)).toEqual(valid);
  });

  it('keeps optional redeem fields', () => {
    expect(
      parseInviteDoc({
        ...valid,
        status: 'redeemed',
        redeemedAt: 3,
        redeemedBy: 'guest',
      }),
    ).toMatchObject({ status: 'redeemed', redeemedAt: 3, redeemedBy: 'guest' });
  });

  const rejectCases: { label: string; raw: unknown }[] = [
    { label: 'null', raw: null },
    { label: 'empty', raw: {} },
    { label: 'bad status', raw: { ...valid, status: 'EXPIRED' } },
    { label: 'zero createdAt', raw: { ...valid, createdAt: 0 } },
    { label: 'empty createdBy', raw: { ...valid, createdBy: '' } },
    { label: 'NaN expiresAt', raw: { ...valid, expiresAt: Number.NaN } },
  ];

  for (const { label, raw } of rejectCases) {
    it(`returns null for ${label}`, () => {
      expect(parseInviteDoc(raw)).toBeNull();
    });
  }
});

describe('mintInviteRecord', () => {
  it('issues an unused row that expires in 7 days', () => {
    const minted = mintInviteRecord('owner-sub', now);
    expect(minted.record.status).toBe('unused');
    expect(minted.record.createdBy).toBe('owner-sub');
    expect(minted.record.expiresAt).toBe(now + INVITE_TTL_MS);
    expect(minted.id).toBe(hashInviteToken(minted.token));
    expect(isInviteTokenShape(minted.token)).toBe(true);
  });
});

describe('unusedUnexpired', () => {
  it('counts only unused rows that have not expired', () => {
    const live = unusedInvite();
    const expired = unusedInvite({ expiresAt: now });
    const redeemed = unusedInvite({ status: 'redeemed' });
    expect(unusedUnexpired([live, expired, redeemed], now)).toEqual([live]);
    expect(INVITE_UNUSED_CAP).toBe(20);
  });
});

describe('inviteLandingVerdict', () => {
  it('joins unused unexpired invites', () => {
    expect(inviteLandingVerdict(unusedInvite(), now)).toEqual({ kind: 'join' });
  });

  it('marks missing, used, revoked, and expired as dead', () => {
    expect(inviteLandingVerdict(null, now)).toEqual({ kind: 'dead', reason: 'unknown' });
    expect(inviteLandingVerdict(unusedInvite({ status: 'redeemed' }), now)).toEqual({
      kind: 'dead',
      reason: 'used',
    });
    expect(inviteLandingVerdict(unusedInvite({ status: 'revoked' }), now)).toEqual({
      kind: 'dead',
      reason: 'revoked',
    });
    expect(inviteLandingVerdict(unusedInvite({ expiresAt: now }), now)).toEqual({
      kind: 'dead',
      reason: 'expired',
    });
  });
});

describe('redeemInviteTransition', () => {
  it('admits a stranger and creates an approved request', () => {
    const r = redeemInviteTransition(unusedInvite(), identity, null, now);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') {
      return;
    }
    expect(r.invite.status).toBe('redeemed');
    expect(r.invite.redeemedBy).toBe('guest-sub');
    expect(r.member).toMatchObject({
      sub: 'guest-sub',
      status: 'active',
      approvedBy: 'owner-sub',
    });
    expect(r.request).toMatchObject({
      sub: 'guest-sub',
      status: 'approved',
      requestCount: 0,
      decidedBy: 'owner-sub',
    });
  });

  it('flips a pending or denied request to approved', () => {
    const pending: AccessRequestRecord = {
      sub: 'guest-sub',
      email: 'old@example.com',
      status: 'denied',
      createdAt: 1,
      updatedAt: 1,
      requestCount: 2,
    };
    const r = redeemInviteTransition(unusedInvite(), identity, pending, now);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') {
      return;
    }
    expect(r.request.status).toBe('approved');
    expect(r.request.email).toBe('guest@example.com');
    expect(r.request.requestCount).toBe(2);
    expect(r.request.name).toBe('Guest');
  });

  it('refuses missing, used, revoked, and expired invites', () => {
    expect(redeemInviteTransition(null, identity, null, now)).toEqual({
      kind: 'refusal',
      reason: 'unknown',
    });
    expect(
      redeemInviteTransition(unusedInvite({ status: 'redeemed' }), identity, null, now),
    ).toEqual({ kind: 'refusal', reason: 'used' });
    expect(
      redeemInviteTransition(unusedInvite({ status: 'revoked' }), identity, null, now),
    ).toEqual({ kind: 'refusal', reason: 'revoked' });
    expect(
      redeemInviteTransition(unusedInvite({ expiresAt: now }), identity, null, now),
    ).toEqual({ kind: 'refusal', reason: 'expired' });
  });
});

describe('revokeInviteTransition', () => {
  it('revokes unused invites and refuses anything else', () => {
    expect(revokeInviteTransition(unusedInvite()).kind).toBe('ok');
    expect(revokeInviteTransition(null)).toEqual({ kind: 'refusal', reason: 'unknown' });
    expect(revokeInviteTransition(unusedInvite({ status: 'redeemed' }))).toEqual({
      kind: 'refusal',
      reason: 'unknown',
    });
  });
});
