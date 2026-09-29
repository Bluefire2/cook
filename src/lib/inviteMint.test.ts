import { describe, expect, it } from 'vitest';
import { inviteMintClient } from './inviteMint';

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
