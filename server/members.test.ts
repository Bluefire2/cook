import { describe, expect, it } from 'vitest';
import {
  composeNotifyDecision,
  decisionTransition,
  nextNotificationCounter,
  nextRequestState,
  parseMemberDoc,
  type AccessRequestRecord,
} from './members.ts';

const identity = { sub: 'user-sub', email: 'u@example.com', name: 'User' };
const DAY_MS = 86_400_000;

function pendingRequest(overrides: Partial<AccessRequestRecord> = {}): AccessRequestRecord {
  return {
    sub: 'user-sub',
    email: 'u@example.com',
    status: 'pending',
    createdAt: 1_000,
    updatedAt: 1_000,
    requestCount: 1,
    lastNotifiedAt: 1_000,
    ...overrides,
  };
}

describe('parseMemberDoc', () => {
  const valid = {
    sub: 'user-sub',
    status: 'active' as const,
    approvedAt: 1,
    approvedBy: 'owner',
  };

  it('returns a record for a fully-formed document', () => {
    expect(parseMemberDoc(valid, 'user-sub')).toEqual(valid);
  });

  const rejectCases: { label: string; raw: unknown; expectedSub?: string }[] = [
    { label: 'null', raw: null },
    { label: 'string', raw: 'x' },
    { label: 'empty object', raw: {} },
    { label: 'bare active', raw: { status: 'active' } },
    {
      label: 'id mismatch',
      raw: { sub: 'other', status: 'active', approvedAt: 1, approvedBy: 'x' },
    },
    { label: 'ACTIVE status', raw: { ...valid, status: 'ACTIVE' } },
    { label: 'pending status', raw: { ...valid, status: 'pending' } },
    { label: 'approvedAt string', raw: { ...valid, approvedAt: '1' } },
    { label: 'approvedAt zero', raw: { ...valid, approvedAt: 0 } },
    { label: 'approvedAt NaN', raw: { ...valid, approvedAt: Number.NaN } },
    { label: 'empty approvedBy', raw: { ...valid, approvedBy: '' } },
  ];

  for (const { label, raw } of rejectCases) {
    it(`returns null for ${label}`, () => {
      expect(parseMemberDoc(raw, 'user-sub')).toBeNull();
    });
  }
});

describe('nextRequestState', () => {
  const fixtures: {
    label: string;
    existing: AccessRequestRecord | null;
    now: number;
    expectWrite: boolean;
    expectEligible: boolean;
    requestCount?: number;
  }[] = [
    {
      label: 'absent',
      existing: null,
      now: 5_000,
      expectWrite: true,
      expectEligible: true,
      requestCount: 1,
    },
    {
      label: 'pending inside 24h window',
      existing: pendingRequest({ lastNotifiedAt: 0, requestCount: 1 }),
      now: 0 + 23 * 3_600_000 + 59 * 60_000,
      expectWrite: false,
      expectEligible: false,
    },
    {
      label: 'pending after 24h with count 4',
      existing: pendingRequest({ lastNotifiedAt: 0, requestCount: 4 }),
      now: 0 + 24 * 3_600_000 + 60_000,
      expectWrite: true,
      expectEligible: true,
      requestCount: 5,
    },
    {
      label: 'pending at ceiling',
      existing: pendingRequest({ lastNotifiedAt: 0, requestCount: 5 }),
      now: 0 + 30 * DAY_MS,
      expectWrite: false,
      expectEligible: false,
    },
    {
      label: 'approved absorbing',
      existing: pendingRequest({ status: 'approved' }),
      now: 0 + 30 * DAY_MS,
      expectWrite: false,
      expectEligible: false,
    },
    {
      label: 'denied absorbing',
      existing: pendingRequest({ status: 'denied' }),
      now: 0 + 30 * DAY_MS,
      expectWrite: false,
      expectEligible: false,
    },
  ];

  for (const fx of fixtures) {
    it(fx.label, () => {
      const result = nextRequestState(fx.existing, identity, fx.now);
      expect(result.write).toBe(fx.expectWrite);
      expect(result.notificationEligible).toBe(fx.expectEligible);
      expect(result.write).toBe(result.notificationEligible);
      if (fx.requestCount !== undefined && result.doc) {
        expect(result.doc.requestCount).toBe(fx.requestCount);
      }
    });
  }

  it('write === notificationEligible for every fixture in the table', () => {
    for (const fx of fixtures) {
      const result = nextRequestState(fx.existing, identity, fx.now);
      expect(result.write).toBe(result.notificationEligible);
    }
  });

  it('is idempotent for write-producing paths', () => {
    const absentNow = 5_000;
    const fromAbsentA = nextRequestState(null, identity, absentNow);
    const fromAbsentB = nextRequestState(null, identity, absentNow);
    expect(fromAbsentA).toEqual(fromAbsentB);
    expect(fromAbsentA.write).toBe(true);
    expect(fromAbsentA.notificationEligible).toBe(true);
    expect(fromAbsentA.doc).not.toBeNull();

    const existing = pendingRequest({ lastNotifiedAt: 0, requestCount: 4 });
    const windowNow = DAY_MS + 1;
    const fromWindowA = nextRequestState(existing, identity, windowNow);
    const fromWindowB = nextRequestState(existing, identity, windowNow);
    expect(fromWindowA).toEqual(fromWindowB);
    expect(fromWindowA.write).toBe(true);
    expect(fromWindowA.notificationEligible).toBe(true);
    expect(fromWindowA.doc?.requestCount).toBe(5);
  });

  it('is idempotent for quiet paths', () => {
    const existing = pendingRequest({ lastNotifiedAt: 0, requestCount: 2 });
    const now = 100_000;
    const a = nextRequestState(existing, identity, now);
    const b = nextRequestState(existing, identity, now);
    expect(a).toEqual(b);
    expect(a.write).toBe(false);
    expect(a.doc).toBeNull();
  });
});

describe('nextNotificationCounter', () => {
  const noonUtc = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('caps at 20 for the same UTC day', () => {
    const atCap = { day: '2026-01-15', count: 20 };
    const r1 = nextNotificationCounter(atCap, noonUtc);
    expect(r1.allowed).toBe(false);
    expect(r1.counter.count).toBe(20);
    const r2 = nextNotificationCounter(atCap, noonUtc + 1_000);
    expect(r2.allowed).toBe(false);
    expect(r2.counter.count).toBe(20);
  });

  it('resets on the next UTC day', () => {
    const atCap = { day: '2026-01-15', count: 20 };
    const nextDay = Date.UTC(2026, 0, 16, 0, 0, 0);
    const r = nextNotificationCounter(atCap, nextDay);
    expect(r.allowed).toBe(true);
    expect(r.counter).toEqual({ day: '2026-01-16', count: 1 });
  });
});

describe('cap-exhausted composition', () => {
  it('advances the request document while delivery notify is false at cap', () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const atCap = { day: '2026-01-15', count: 20 };
    const existing = pendingRequest({ lastNotifiedAt: now - DAY_MS, requestCount: 1 });
    const state = nextRequestState(existing, identity, now);
    expect(state.write).toBe(true);
    expect(state.notificationEligible).toBe(true);
    expect(state.doc).not.toBeNull();
    expect(state.doc!.requestCount).toBe(2);
    expect(state.doc!.lastNotifiedAt).toBe(now);
    expect(state.doc!.updatedAt).toBe(now);

    const deliveryAllowed = composeNotifyDecision(state.notificationEligible, atCap, now);
    expect(deliveryAllowed).toBe(false);
    const notify = state.notificationEligible && deliveryAllowed;
    expect(notify).toBe(false);
  });

  it('does not consult counter when notificationEligible is false', () => {
    const atCap = { day: '2026-01-15', count: 20 };
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(composeNotifyDecision(false, atCap, now)).toBe(false);
  });
});

describe('decisionTransition', () => {
  const now = 9_000;

  it('refuses unknown request', () => {
    expect(decisionTransition(null, 'approve', 'owner', now)).toEqual({
      kind: 'refusal',
      reason: 'unknown-request',
    });
  });

  it('refuses self', () => {
    const existing = pendingRequest();
    expect(decisionTransition(existing, 'approve', existing.sub, now)).toEqual({
      kind: 'refusal',
      reason: 'self',
    });
  });

  it('approves pending', () => {
    const existing = pendingRequest();
    const r = decisionTransition(existing, 'approve', 'owner-sub', now);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.request.status).toBe('approved');
      expect(r.member).toMatchObject({ status: 'active', sub: existing.sub });
    }
  });

  it('denies pending', () => {
    const existing = pendingRequest();
    const r = decisionTransition(existing, 'deny', 'owner-sub', now);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.request.status).toBe('denied');
      expect(r.member).toBeNull();
    }
  });
});
