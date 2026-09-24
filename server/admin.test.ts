import { describe, expect, it } from 'vitest';
import {
  parseAdminListCursors,
  parseDecisionBody,
  parseRevokeInviteBody,
  serializeAccessRequestLists,
  serializeInviteList,
  toAdminAccessRequestEntry,
} from './admin.ts';
import type { AccessRequestLists, AccessRequestRecord } from './members.ts';

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
});
