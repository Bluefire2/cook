import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminDecisionPost,
  adminInviteRevokePost,
  adminInvitesPost,
  memberInvitesPost,
  parseAdminListCursors,
  parseDecisionBody,
  parseRevokeInviteBody,
  serializeAccessRequestLists,
  serializeInviteList,
  toAdminAccessRequestEntry,
} from './admin.ts';
import { INVITE_UNUSED_CAP, MEMBER_INVITE_LIMIT } from './invites.ts';
import * as invites from './invites.ts';
import * as members from './members.ts';
import * as membership from './membership.ts';
import type { AccessRequestLists, AccessRequestRecord } from './members.ts';
import { SESSION_COOKIE_NAME, signSession } from './session.ts';

vi.mock('./invites.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invites.ts')>();
  return {
    ...actual,
    mintInvite: vi.fn(actual.mintInvite),
    mintMemberInvite: vi.fn(actual.mintMemberInvite),
    revokeInvite: vi.fn(actual.revokeInvite),
  };
});

vi.mock('./membership.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./membership.ts')>();
  return {
    ...actual,
    requireMember: vi.fn(actual.requireMember),
  };
});

vi.mock('./members.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./members.ts')>();
  return {
    ...actual,
    applyDecision: vi.fn(actual.applyDecision),
  };
});

describe('parseAdminListCursors', () => {
  it('passes valid cursors and ignores invalid ones', () => {
    const params = new URLSearchParams({
      afterPending: 'valid-sub_1',
      afterApproved: 'bad/sub',
      afterDenied: '',
    });
    expect(parseAdminListCursors(params)).toEqual({
      pending: 'valid-sub_1',
      approved: undefined,
      denied: undefined,
    });
  });
});

describe('parseDecisionBody', () => {
  it('accepts approve, deny and revoke', () => {
    expect(parseDecisionBody({ sub: 'user-1', action: 'approve' })).toEqual({
      sub: 'user-1',
      action: 'approve',
    });
  });

  it('rejects invalid sub or action', () => {
    expect(parseDecisionBody({ sub: 'bad/sub', action: 'approve' })).toBe('invalid');
    expect(parseDecisionBody({ sub: 'user-1', action: 'nope' })).toBe('invalid');
    expect(parseDecisionBody(null)).toBe('invalid');
  });
});

describe('serializeAccessRequestLists', () => {
  it('maps createdAt to requestedAt', () => {
    const row: AccessRequestRecord = {
      sub: 's1',
      email: 'a@example.com',
      status: 'pending',
      createdAt: 100,
      updatedAt: 200,
      requestCount: 2,
      decidedAt: 300,
    };
    expect(toAdminAccessRequestEntry(row)).toEqual({
      sub: 's1',
      email: 'a@example.com',
      requestedAt: 100,
      decidedAt: 300,
      requestCount: 2,
    });
    const lists: AccessRequestLists = {
      pending: { rows: [row], nextCursor: null },
      approved: { rows: [], nextCursor: null },
      denied: { rows: [], nextCursor: null },
    };
    expect(serializeAccessRequestLists(lists).pending.rows[0]?.requestedAt).toBe(100);
  });
});

describe('parseRevokeInviteBody', () => {
  it('accepts a sha256 hex id', () => {
    const id = 'ab'.repeat(32);
    expect(parseRevokeInviteBody({ id })).toEqual({ id });
  });

  it('rejects missing, short, or uppercase ids', () => {
    expect(parseRevokeInviteBody(null)).toBe('invalid');
    expect(parseRevokeInviteBody({ id: 'ab' })).toBe('invalid');
    expect(parseRevokeInviteBody({ id: 'AB'.repeat(32) })).toBe('invalid');
  });
});

describe('serializeInviteList', () => {
  it('maps id, createdAt and expiresAt and omits secrets', () => {
    const serialized = serializeInviteList([
      {
        id: 'aa'.repeat(32),
        record: {
          status: 'unused',
          createdAt: 10,
          createdBy: 'owner',
          expiresAt: 20,
        },
      },
    ]);
    expect(serialized).toEqual({
      invites: [{ id: 'aa'.repeat(32), createdAt: 10, expiresAt: 20 }],
    });
  });

  it('includes creatorEmail when the invite stored one', () => {
    const serialized = serializeInviteList([
      {
        id: 'bb'.repeat(32),
        record: {
          status: 'unused',
          createdAt: 10,
          createdBy: 'member',
          createdByEmail: 'member@example.com',
          expiresAt: 20,
        },
      },
    ]);
    expect(serialized.invites[0]).toEqual({
      id: 'bb'.repeat(32),
      createdAt: 10,
      expiresAt: 20,
      creatorEmail: 'member@example.com',
    });
  });
});

describe('admin JSON error codes', () => {
  const prev = {
    secret: process.env.SESSION_SECRET,
    allowed: process.env.ALLOWED_EMAILS,
  };

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    process.env.ALLOWED_EMAILS = 'allowed@example.com';
  });

  afterEach(() => {
    if (prev.secret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = prev.secret;
    }
    if (prev.allowed === undefined) {
      delete process.env.ALLOWED_EMAILS;
    } else {
      process.env.ALLOWED_EMAILS = prev.allowed;
    }
  });

  function ownerPost(url: string, body: unknown): Request {
    const token = signSession({ sub: 'owner-sub', email: 'allowed@example.com' }, Date.now());
    return new Request(url, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  it('moves self onto code and a readable sentence', async () => {
    const response = await adminDecisionPost(
      ownerPost('http://localhost/api/admin/decision', { sub: 'owner-sub', action: 'deny' }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You can't change your own access.",
      code: 'self',
    });
  });

  it('moves unknown-request onto code and a readable sentence', async () => {
    vi.mocked(members.applyDecision).mockResolvedValueOnce({
      kind: 'refusal',
      reason: 'unknown-request',
    });
    const response = await adminDecisionPost(
      ownerPost('http://localhost/api/admin/decision', { sub: 'other-user', action: 'approve' }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'That access request was not found.',
      code: 'unknown-request',
    });
  });

  it('moves invite-cap onto code and sends max', async () => {
    vi.mocked(invites.mintInvite).mockResolvedValueOnce({ kind: 'cap' });
    const token = signSession({ sub: 'owner-sub', email: 'allowed@example.com' }, Date.now());
    const response = await adminInvitesPost(
      new Request('http://localhost/api/admin/invites', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: `There are already ${INVITE_UNUSED_CAP} unused invite links. Revoke one to mint another.`,
      code: 'invite-cap',
      max: INVITE_UNUSED_CAP,
    });
    expect(invites.mintInvite).toHaveBeenCalledWith(
      'owner-sub',
      expect.any(Number),
      'allowed@example.com',
    );
  });

  it('moves unknown-invite onto code and a readable sentence', async () => {
    vi.mocked(invites.revokeInvite).mockResolvedValueOnce({
      kind: 'refusal',
      reason: 'unknown',
    });
    const response = await adminInviteRevokePost(
      ownerPost('http://localhost/api/admin/invites/revoke', { id: 'ab'.repeat(32) }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'That invite link was not found.',
      code: 'unknown-invite',
    });
  });
});

describe('memberInvitesPost', () => {
  const prev = {
    secret: process.env.SESSION_SECRET,
    allowed: process.env.ALLOWED_EMAILS,
    origin: process.env.PUBLIC_ORIGIN,
  };

  beforeEach(async () => {
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    process.env.ALLOWED_EMAILS = 'allowed@example.com';
    process.env.PUBLIC_ORIGIN = 'https://sous.example';
    vi.mocked(invites.mintMemberInvite).mockReset();
    const actual = await vi.importActual<typeof import('./membership.ts')>('./membership.ts');
    vi.mocked(membership.requireMember).mockReset();
    vi.mocked(membership.requireMember).mockImplementation((req) => actual.requireMember(req));
  });

  afterEach(() => {
    if (prev.secret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = prev.secret;
    }
    if (prev.allowed === undefined) {
      delete process.env.ALLOWED_EMAILS;
    } else {
      process.env.ALLOWED_EMAILS = prev.allowed;
    }
    if (prev.origin === undefined) {
      delete process.env.PUBLIC_ORIGIN;
    } else {
      process.env.PUBLIC_ORIGIN = prev.origin;
    }
  });

  it('returns only the url for a member', async () => {
    vi.mocked(membership.requireMember).mockResolvedValueOnce({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    });
    vi.mocked(invites.mintMemberInvite).mockResolvedValueOnce({
      kind: 'ok',
      token: 'member-token',
      id: 'ab'.repeat(32),
    });
    const response = await memberInvitesPost(
      new Request('http://localhost/api/invites', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: 'https://sous.example/invite/member-token',
    });
    expect(invites.mintMemberInvite).toHaveBeenCalledWith(
      'member-sub',
      'member@example.com',
      expect.any(Number),
    );
  });

  it('returns member-invite-cap without an invite list', async () => {
    vi.mocked(membership.requireMember).mockResolvedValueOnce({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    });
    vi.mocked(invites.mintMemberInvite).mockResolvedValueOnce({ kind: 'cap' });
    const response = await memberInvitesPost(
      new Request('http://localhost/api/invites', { method: 'POST' }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'There are already too many unused invite links. Try again later.',
      code: 'member-invite-cap',
    });
  });

  it('returns member-invite-limit and does not include an invite list', async () => {
    vi.mocked(membership.requireMember).mockResolvedValueOnce({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    });
    vi.mocked(invites.mintMemberInvite).mockResolvedValueOnce({ kind: 'limit' });
    const response = await memberInvitesPost(
      new Request('http://localhost/api/invites', { method: 'POST' }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: `You have already invited ${MEMBER_INVITE_LIMIT} people.`,
      code: 'member-invite-limit',
      max: MEMBER_INVITE_LIMIT,
    });
  });

  it('refuses an owner and does not mint', async () => {
    const token = signSession({ sub: 'owner-sub', email: 'allowed@example.com' }, Date.now());
    const response = await memberInvitesPost(
      new Request('http://localhost/api/invites', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden', code: 'forbidden' });
    expect(invites.mintMemberInvite).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller and does not mint', async () => {
    const response = await memberInvitesPost(
      new Request('http://localhost/api/invites', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(invites.mintMemberInvite).not.toHaveBeenCalled();
  });

  it('returns 503 when membership is unknown and does not mint', async () => {
    vi.mocked(membership.requireMember).mockResolvedValueOnce({ kind: 'unknown' });
    const response = await memberInvitesPost(
      new Request('http://localhost/api/invites', { method: 'POST' }),
    );
    expect(response.status).toBe(503);
    expect(invites.mintMemberInvite).not.toHaveBeenCalled();
  });
});
