import { describe, expect, it } from 'vitest';
import {
  parseAdminListCursors,
  parseDecisionBody,
  serializeAccessRequestLists,
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
