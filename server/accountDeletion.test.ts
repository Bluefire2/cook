import { describe, expect, it } from 'vitest';
import {
  deletionRefusal,
  FIRESTORE_COLLECTIONS,
  invitePlan,
  ownerShareNeedsTombstone,
  personalTopLevelCollections,
} from './accountDeletion.ts';
import { incomingShareCascadeDoc, incomingSharePayload } from './grants.ts';

const SUB = '109876543210987654321';
const OWNER = '123456789012345678901';
const COLLECTION = '0b6f6a6e-3a3c-4c55-9a59-3f0c8c1d2e4f';

describe('FIRESTORE_COLLECTIONS', () => {
  it('marks every top-level collection that holds a member as personal, and only the counter as not', () => {
    expect(personalTopLevelCollections().sort()).toEqual(
      [
        'accessRequests',
        'collectionLinks',
        'featureRequests',
        'importFeedback',
        'incomingShares',
        'invites',
        'mcpAuthCodes',
        'mcpTokens',
        'members',
        'users',
      ].sort(),
    );
    expect(FIRESTORE_COLLECTIONS.accessRequestMeta).toMatchObject({ scope: 'top-level', personal: false });
  });
});

describe('deletionRefusal', () => {
  const base = { sub: SUB, memberStatus: 'revoked', profileEmail: 'gone@example.com', allowedRaw: 'owner@example.com' };

  it('allows a member whose access is already denied', () => {
    expect(deletionRefusal(base)).toBeNull();
    expect(deletionRefusal({ ...base, memberStatus: undefined, profileEmail: undefined })).toBeNull();
  });

  it('refuses while the member is still active or an owner, or when owners cannot be ruled out', () => {
    expect(deletionRefusal({ ...base, memberStatus: 'active' })).toBe('still-member');
    expect(deletionRefusal({ ...base, profileEmail: 'Owner@Example.com' })).toBe('owner');
    expect(deletionRefusal({ ...base, allowedRaw: '  ' })).toBe('no-allowlist');
  });

  it('refuses a sub that is not a document id', () => {
    expect(deletionRefusal({ ...base, sub: 'a/b' })).toBe('bad-sub');
    expect(deletionRefusal({ ...base, sub: '' })).toBe('bad-sub');
  });
});

describe('invitePlan', () => {
  it('deletes what the member minted and scrubs what they redeemed from someone else', () => {
    expect(
      invitePlan(
        ['minted-1', 'minted-2'],
        [
          { id: 'from-owner', createdBy: OWNER },
          { id: 'minted-1', createdBy: SUB },
        ],
        SUB,
      ),
    ).toEqual({ deleteIds: ['minted-1', 'minted-2'], scrubIds: ['from-owner'] });
  });
});

describe('ownerShareNeedsTombstone', () => {
  it('is true for a live share or a tombstone that still carries the owner email', () => {
    const live = incomingSharePayload(OWNER, COLLECTION, 5, { ownerEmail: 'owner@example.com', role: 'viewer' });
    expect(ownerShareNeedsTombstone(live)).toBe(true);
    expect(ownerShareNeedsTombstone({ ...live, deletedAt: 6 })).toBe(true);
    expect(ownerShareNeedsTombstone({ ownerEmail: 'x@example.com' })).toBe(true);
  });

  it('is false for a missing share or a clean tombstone, which is what the step writes', () => {
    expect(ownerShareNeedsTombstone(undefined)).toBe(false);
    const written = incomingShareCascadeDoc(undefined, OWNER, COLLECTION, 9);
    expect(written).not.toHaveProperty('ownerEmail');
    expect(ownerShareNeedsTombstone(written)).toBe(false);
  });
});
