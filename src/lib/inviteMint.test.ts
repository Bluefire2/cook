import { describe, expect, it } from 'vitest';
import { inviteMintClient, isInviteQuotaError } from './inviteMint';

describe('inviteMintClient', () => {
  it('returns admin only when isOwner is true', () => {
    expect(inviteMintClient({ isOwner: true })).toBe('admin');
  });
  it('returns member when isOwner is false', () => {
    expect(inviteMintClient({ isOwner: false })).toBe('member');
  });
  it('returns member when isOwner is omitted', () => {
    expect(inviteMintClient({})).toBe('member');
  });
});

describe('isInviteQuotaError', () => {
  it('recognizes the personal limit and both unused-link caps', () => {
    expect(isInviteQuotaError(Object.assign(new Error('limit'), { code: 'member-invite-limit' }))).toBe(
      true,
    );
    expect(isInviteQuotaError(Object.assign(new Error('cap'), { code: 'member-invite-cap' }))).toBe(true);
    expect(isInviteQuotaError(Object.assign(new Error('cap'), { code: 'invite-cap' }))).toBe(true);
  });

  it('ignores other failures', () => {
    expect(isInviteQuotaError(new Error('nope'))).toBe(false);
    expect(isInviteQuotaError(Object.assign(new Error('down'), { code: 'forbidden' }))).toBe(false);
    expect(isInviteQuotaError(null)).toBe(false);
  });
});
